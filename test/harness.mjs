// ============================================================================
//  harness.mjs — boot plugin/index.js with a fake Cordis context and a
//  scriptable `herdr` CLI. No Herdr server, no dsh process, no network.
//
//  The plugin's only contact with the outside world is `ctx.shell` (to run
//  `herdr`), `ctx.tools` (to register tools), `ctx.inject(['shell','timer'])`
//  (to start its watcher) and `node:fs` (its ledger). All four are faked or
//  redirected here, so every branch is reachable from a test.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE_URL = new URL('../plugin/index.js', import.meta.url)

// ------------------------------- fake clock ---------------------------------

/** Controllable wall clock. core.mjs reads `Date.now()` on every call. */
export const clock = {
  now: 1_700_000_000_000,
  install() {
    this._real = Date.now
    Date.now = () => this.now
  },
  restore() {
    if (this._real) Date.now = this._real
  },
  advance(ms) { this.now += ms },
}

// ------------------------------ argument parsing -----------------------------
// The plugin quotes arguments for pwsh ('...' with '' escapes) and passes
// prompts as a base64 expression. These helpers undo both.

/** @param {string} token @returns {string} the token with pwsh single-quoting removed. */
export function unquote(token) {
  const text = String(token)
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/** @param {string} command @returns {string | null} the base64-decoded prompt text. */
export function decodePrompt(command) {
  const pwsh = command.match(/FromBase64String\('([^']+)'\)/)
  if (pwsh) return Buffer.from(pwsh[1], 'base64').toString('utf8')
  const bash = command.match(/printf %s '([^']+)' \| base64 -d/)
  if (bash) return Buffer.from(bash[1], 'base64').toString('utf8')
  return null
}

// ------------------------------- fake Herdr ----------------------------------

/**
 * Mutable Herdr world. Tests mutate this and observe what the plugin does.
 * @param {object} [overrides]
 */
export function makeWorld(overrides = {}) {
  const world = {
    agents: [],
    tails: {},
    prompts: [],
    keys: [],
    calls: [],
    workspaces: 0,
    failSnapshot: false,
    failPrompt: false,
    waitStatus: 'idle',
    schemaJson: { properties: { pane_id: { type: 'string' }, agent_status: { type: 'string' } } },
    /**
     * Move an agent to a new lifecycle status.
     * @param {string} name @param {string} status
     */
    setStatus(name, status) {
      const agent = world.agents.find(candidate => candidate.name === name)
      if (agent) agent.status = status
    },
    ...overrides,
  }
  return world
}

/** @returns {{exitCode: number, signal: null, timedOut: boolean, aborted: boolean, timeoutMs: number, stdout: object, stderr: object}} */
function ok(text) {
  return {
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 30_000,
    stdout: { text: text ?? '', truncated: false },
    stderr: { text: '', truncated: false },
  }
}

function fail(text, exitCode = 1) {
  return {
    exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 30_000,
    stdout: { text: '', truncated: false },
    stderr: { text: text ?? '', truncated: false },
  }
}

/**
 * Route one `herdr ...` command line against the world.
 * @param {object} world @param {string} command @returns {object} a ShellRunResult
 */
export function routeHerdr(world, command) {
  world.calls.push(command)
  if (!command.startsWith('herdr ')) return fail(`unexpected command: ${command.slice(0, 80)}`)
  const rest = command.slice('herdr '.length).trim()

  if (rest === '--version') return ok('herdr 0.9.1\n')

  if (rest.startsWith('api snapshot')) {
    if (world.failSnapshot) return fail('herdr: could not connect to the herdr server')
    return ok(JSON.stringify({
      result: {
        agents: world.agents.map(agent => ({
          name: agent.name,
          agent: agent.kind,
          pane_id: agent.paneId ?? `${agent.name}:p1`,
          status: agent.status,
          workspace_id: agent.ws ?? 'w1',
        })),
      },
    }))
  }

  if (rest.startsWith('api schema')) {
    return ok(JSON.stringify(world.schemaJson))
  }

  if (rest.startsWith('workspace create')) {
    world.workspaces += 1
    const id = `w${world.workspaces}`
    return ok(JSON.stringify({
      result: { workspace: { workspace_id: id }, root_pane: { pane_id: `${id}:p1` } },
    }))
  }

  let match
  if ((match = rest.match(/^agent start (\S+) --kind (\S+) --pane (.+)$/))) {
    world.agents.push({ name: match[1], kind: match[2], paneId: unquote(match[3]), status: 'idle', ws: 'w1' })
    return ok(JSON.stringify({ result: { agent: { name: match[1], status: 'idle' } } }))
  }

  if ((match = rest.match(/^agent prompt (.+?) (?=\[Text\.Encoding\]|"\$\(printf)/))) {
    if (world.failPrompt) return fail('herdr: agent_blocked')
    const text = decodePrompt(rest)
    world.prompts.push({ name: unquote(match[1]), text })
    return ok(JSON.stringify({ result: { agent: { name: unquote(match[1]) } } }))
  }

  if ((match = rest.match(/^agent read (.+?) --source (\S+) --lines (\d+)$/))) {
    const name = unquote(match[1])
    return ok(world.tails[name] ?? '')
  }

  if ((match = rest.match(/^agent send-keys (.+?) (\S+)$/))) {
    const name = unquote(match[1])
    world.keys.push({ name, key: match[2] })
    // Deliberately does NOT transition the agent's status. Real Herdr takes a
    // moment to reflect an interrupt, and a test double that flips instantly
    // would hide the plugin's re-halt guard entirely. Tests that want the
    // transition call `world.setStatus`.
    return ok(JSON.stringify({ result: { type: 'ok' } }))
  }

  if ((match = rest.match(/^agent wait (.+?) ((?:--until \S+ ?)+)--timeout (\d+)$/))) {
    return ok(JSON.stringify({ result: { status: world.waitStatus } }))
  }

  return fail(`unrouted herdr args: ${rest.slice(0, 120)}`)
}

// ----------------------------- fake services ---------------------------------

/** @returns {object} a `ctx.shell` whose `run` consults the fake Herdr world. */
function makeShell(world) {
  return {
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 30_000,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 2 * 1024 * 1024,
      }
    },
    async run(spec) { return routeHerdr(world, spec.command) },
  }
}

/**
 * Boot the plugin against a fake context.
 * @param {object} [options]
 * @param {object} [options.world] - pre-seeded Herdr world.
 * @param {object} [options.config] - plugin config overrides.
 * @param {boolean} [options.withShell] - set false to simulate a profile without `ctx.shell`.
 * @param {boolean} [options.withInject] - set false to simulate a context without `ctx.inject`.
 * @returns {Promise<object>} the boot result.
 */
export async function bootPlugin(options = {}) {
  const world = options.world ?? makeWorld()
  const registered = new Map()
  const warnings = []
  const brain = {
    id: 'brain-session-1',
    status: 'idle',
    steers: [],
    steer(message) { this.steers.push(message) },
  }

  const services = {
    shell: options.withShell === false ? undefined : makeShell(world),
    agents: { get: id => (id === brain.id ? brain : undefined) },
  }

  /** The watcher callback, captured from the plugin's `ctx.inject(['shell','timer'], …)`. */
  const timer = { callback: undefined, ms: undefined, injections: [] }
  const timerContext = {
    setInterval(callback, ms) {
      timer.callback = callback
      timer.ms = ms
      return () => { timer.callback = undefined }
    },
  }

  const effects = []
  const ctx = {
    logger: { warn: (...args) => { warnings.push(args.map(String).join(' ')) } },
    get: name => services[name],
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
    },
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  // A context without the `inject` verb models a host whose Cordis build does
  // not offer deferred service acquisition; the plugin must degrade to
  // "tools work, watcher never starts" rather than failing to load.
  if (options.withInject !== false) {
    ctx.inject = (names, callback) => {
      timer.injections.push(names)
      callback(timerContext)
      return () => {}
    }
  }

  // A fresh ledger directory per boot, so tests never share durable state.
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'herdr-fleet-test-'))
  const module = await import(`${SOURCE_URL.href}?v=${Math.random()}`)
  module.apply(ctx, {
    stateDir,
    shellFlavor: 'pwsh',
    tickSeconds: 10,
    readEveryTicks: 1,
    shellTimeoutMs: 30_000,
    ...options.config,
  })

  // The plugin loads its ledger in an effect, asynchronously.
  await settle()

  /**
   * Invoke a registered tool with the brain as its owning agent.
   * @param {string} name @param {object} [args] @param {object} [exec]
   */
  async function callTool(name, args = {}, exec = { agent: brain }) {
    const tool = registered.get(name)
    if (!tool) throw new Error(`tool not registered: ${name} (have: ${[...registered.keys()].join(', ')})`)
    return tool.execute(args, exec)
  }

  /** Render a tool result exactly as the model would see it. */
  function renderTool(name, args, value) {
    const tool = registered.get(name)
    if (!tool) throw new Error(`tool not registered: ${name}`)
    return tool.output.render(args ?? {}, value)
  }

  /** Run one watcher tick and wait for it to finish. */
  async function runTick() {
    if (!timer.callback) throw new Error('watcher was not started')
    const pending = timer.callback()
    if (pending && typeof pending.then === 'function') {
      await pending
      return
    }
    // Fallback for a callback that does not hand back its promise: draining
    // macrotasks lets purely promise-based work settle.
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  }

  /** Await the plugin's own promises (ledger load, tick completion). */
  async function settle() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }

  /** Read the ledger the plugin persisted. */
  function readLedger() {
    return JSON.parse(readFileSync(join(stateDir, 'ledger.json'), 'utf8'))
  }

  /**
   * Read the ledger, or null when nothing has been persisted yet. The plugin
   * only writes when something changed, so a quiet tick legitimately leaves no
   * file.
   */
  function readLedgerOrNull() {
    try { return readLedger() } catch { return null }
  }

  function cleanup() {
    try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  return {
    world, brain, registered, warnings, timer, ctx, stateDir,
    callTool, renderTool, runTick, settle, readLedger, readLedgerOrNull, cleanup, module,
  }
}

// ------------------------------- assertions ----------------------------------
// A tiny reporter: no test framework, so the suite runs with plain `node`.

let passed = 0
let failed = 0
const failures = []

/** @param {string} name @param {unknown} condition @param {string} [detail] */
export function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** @param {string} name @param {unknown} actual @param {unknown} expected */
export function checkEqual(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** @param {string} label */
export function section(label) { console.log(`\n${label}`) }

/** @returns {number} the process exit code for the run. */
export function summary() {
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failures.length > 0) console.log(`failed: ${failures.join(', ')}`)
  return failed === 0 ? 0 : 1
}
