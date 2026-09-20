// ============================================================================
//  herdr-fleet — a native DeepSeek Harness plugin.
// ----------------------------------------------------------------------------
//  DSH is the brain; Herdr is the nervous system; the agents in Herdr's panes
//  are the hands.
//
//  This plugin is a CONTROL PLANE, never a strategist. It does four things and
//  refuses to do a fifth:
//
//    1. METER   — accrues each agent's wall-clock working time from Herdr's own
//                 lifecycle authority, against a per-agent budget (5h default)
//                 inside a rolling window (24h default).
//    2. DETECT  — recognises provider throttling in an agent's terminal output,
//                 and agents parked on an approval prompt.
//    3. SNAPSHOT— at the moment it halts an agent, records "where it left off":
//                 why it stopped plus the tail of what it had produced.
//    4. HAND OFF— gives the brain a tool to resume that snapshot on a different
//                 agent, so a rate-limited fleet keeps working.
//
//  It decides nothing about what the work IS. Choosing the next agent, the next
//  task, and whether a handoff is worthwhile is the model's job.
//
//  Install: `dsh plugin --profile <name> add <this-dir>` with this directory's
//  absolute path. There is no model-facing install tool. See README.md.
// ============================================================================

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  AGENT_STATUSES, KINDS, accrueWorking, budgetFor, clamp, continuationPrompt, defaultLedger,
  deriveAgentName, hours, isAgentName, makeHandoff, makeId, meterEntry, normalizeAgents,
  nowMs, pushBounded, quoteArg, rateLimitStep, renderStatus, reviveLedger, round2, safeJson,
  shellTextArg, splitParks, statusView, truncate, truncateHead, usedMs,
} from './core.mjs'

export const name = 'herdr-fleet'

// ONLY `tools` is a hard requirement. Cordis does not run `apply` at all while
// any declared `inject` entry is missing, and `inject` has no optional form — so
// listing `shell` or `timer` here would make the whole plugin silently inactive
// in any profile that lacks one, with no tool and no error. Both are acquired as
// runtime dependencies instead: the watcher through `ctx.inject([...])`, and the
// herdr CLI through a per-call lookup that reports a real message when absent.
export const inject = ['tools']

/** Bound on the `fleet_wait` tool so a settle-wait cannot outlive its own call. */
const WAIT_TOOL_TIMEOUT_MS = 120_000

/**
 * Deployment-varying settings. Every field is changeable from the profile's
 * `cordis.patch.yml` under this plugin's insert row.
 */
export const Config = z.object({
  /** Working hours allowed per agent inside the rolling window. */
  budgetHours: z.number().default(5),
  /** Length of the rolling window the budget is measured over. */
  windowHours: z.number().default(24),
  /** Watcher cadence in seconds. One `herdr api snapshot` per tick. */
  tickSeconds: z.number().default(10),
  /** Read each working agent's output tail every N ticks (rate-limit scan). */
  readEveryTicks: z.number().default(3),
  /** Lines of output tail to read per scan. */
  readLines: z.number().default(60),
  /** Consecutive throttled scans before an agent is halted (anti-noise). */
  rlConfirmScans: z.number().default(2),
  /** Cooldown before the same agent may trigger another rate-limit halt. */
  rlCooldownMinutes: z.number().default(10),
  /**
   * How long a halt is trusted before the agent may be halted again, when Herdr
   * still reports it `working`. Covers a slow or ignored interrupt.
   */
  haltSettleMinutes: z.number().default(5),
  /** Halt an agent automatically when its budget or a rate limit is reached. */
  autoHalt: z.boolean().default(true),
  /** Send a notice to the brain when an agent blocks on an approval prompt. */
  notifyOnBlocked: z.boolean().default(true),
  /** `herdr` executable name or absolute path. */
  herdrBin: z.string().default('herdr'),
  /** Ledger directory. Empty resolves to `<os home>/.dsh/herdr-fleet`. */
  stateDir: z.string().default(''),
  /** Shell flavor used to quote prompts: 'pwsh' or 'bash'. Empty auto-detects. */
  shellFlavor: z.string().default(''),
  /** Foreground timeout for one herdr invocation. */
  shellTimeoutMs: z.number().default(30_000),
  /** stdout capture budget per herdr invocation. */
  stdoutMaxBytes: z.number().default(2 * 1024 * 1024),
  /** Parked resumes whose moment passed while dsh was down are skipped, not fired. */
  staleParkGraceMinutes: z.number().default(30),
  /** Deliver notices live to the owning agent (off = queue for fleet_status only). */
  liveNotices: z.boolean().default(true),
})

/** @returns {'pwsh' | 'bash'} the quoting flavor for this deployment. */
function detectFlavor(configured) {
  if (configured === 'pwsh' || configured === 'bash') return configured
  return typeof process !== 'undefined' && process.platform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * The plugin body.
 * @param {object} ctx - the Cordis context.
 * @param {object} [config] - values validated against {@link Config}.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  /**
   * A strictly positive number, or the fallback.
   *
   * Deliberately NOT `Math.max(floor, value)`: a floor of 1 turned
   * `budgetHours: 0.5` into a full hour, silently overriding the operator's
   * setting. Only genuinely absent, non-numeric, or non-positive values fall
   * back.
   * @param {unknown} value @param {number} fallback @returns {number}
   */
  const positive = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }
  const whole = (value, fallback) => Math.max(1, Math.floor(positive(value, fallback)))
  const nonNegative = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : fallback
  }

  const cfg = {
    budgetMs: positive(config.budgetHours, 5) * 3_600_000,
    windowMs: positive(config.windowHours, 24) * 3_600_000,
    tickMs: positive(config.tickSeconds, 10) * 1000,
    readEveryTicks: whole(config.readEveryTicks, 3),
    readLines: whole(config.readLines, 60),
    rlConfirmScans: whole(config.rlConfirmScans, 2),
    rlCooldownMs: nonNegative(config.rlCooldownMinutes, 10) * 60_000,
    haltSettleMs: nonNegative(config.haltSettleMinutes, 5) * 60_000,
    autoHalt: config.autoHalt ?? true,
    notifyOnBlocked: config.notifyOnBlocked ?? true,
    herdrBin: String(config.herdrBin ?? 'herdr'),
    stateDir: String(config.stateDir ?? '') || join(homedir(), '.dsh', 'herdr-fleet'),
    flavor: detectFlavor(config.shellFlavor),
    shellTimeoutMs: positive(config.shellTimeoutMs, 30_000),
    stdoutMaxBytes: positive(config.stdoutMaxBytes, 2 * 1024 * 1024),
    staleParkGraceMs: nonNegative(config.staleParkGraceMinutes, 30) * 60_000,
    liveNotices: config.liveNotices ?? true,
  }

  const ledgerPath = join(cfg.stateDir, 'ledger.json')

  /** Runtime state. `ledger` is the durable half and is what gets persisted. */
  const state = {
    ledger: defaultLedger(),
    brainAgentId: '',
    lastSnapshot: null,
    reachable: true,
    lastError: '',
    tickCount: 0,
    lastTickMs: 0,
    dirty: false,
    blockedSeen: {},
    halted: {},
  }

  const warn = (message, error) => {
    try { ctx.logger?.warn?.(`herdr-fleet: ${message}`, error) } catch { /* logging must never fail a tick */ }
  }

  // ---------------------------------------------------------------------------
  // herdr CLI bridge
  // ---------------------------------------------------------------------------

  /** @returns {object | undefined} the injected shell service, when present. */
  const shellService = () => {
    try { return ctx.get?.('shell') } catch { return undefined }
  }

  /**
   * Run one herdr invocation and return its captured streams.
   * @param {string} args - the argument string appended to the herdr binary.
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{stdout: string, stderr: string}>}
   */
  async function runHerdr(args, options = {}) {
    const shell = shellService()
    if (!shell) {
      throw new Error('the `shell` service is unavailable, so herdr-fleet cannot run the herdr CLI')
    }
    const spec = shell.resolve({
      command: `${cfg.herdrBin} ${args}`,
      timeoutMs: options.timeoutMs ?? cfg.shellTimeoutMs,
      stdoutMaxBytes: cfg.stdoutMaxBytes,
    })
    const result = await shell.run(spec)
    const stdout = result?.stdout?.text ?? ''
    const stderr = result?.stderr?.text ?? ''
    if (result?.timedOut) {
      throw new Error(`herdr ${args} timed out after ${spec.timeoutMs}ms`)
    }
    if (result?.exitCode !== 0) {
      throw new Error(`herdr ${args} failed (exit ${result.exitCode}): ${truncate(stderr || stdout, 400) || 'no output'}`)
    }
    return { stdout, stderr }
  }

  /**
   * Run a herdr verb that prints JSON, falling back to `{rawText}` for the verbs
   * that print rendered terminal text (`agent read`).
   * @param {string} args @param {{timeoutMs?: number}} [options]
   * @returns {Promise<object>}
   */
  async function herdrJson(args, options = {}) {
    const { stdout } = await runHerdr(args, options)
    const parsed = safeJson(stdout)
    return parsed.ok ? parsed.value : { rawText: stdout }
  }

  /** Same as {@link runHerdr} but resolves an `{error}` object instead of throwing. */
  async function herdrQuiet(args, options = {}) {
    try { return await runHerdr(args, options) } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  // ---------------------------------------------------------------------------
  // ledger persistence
  // ---------------------------------------------------------------------------

  async function loadLedger() {
    try {
      const text = await readFile(ledgerPath, 'utf8')
      state.ledger = reviveLedger(JSON.parse(text))
      state.brainAgentId = String(state.ledger.meta?.brainAgentId ?? '')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(`could not read ${ledgerPath}; starting from an empty ledger`, error)
      }
    }
  }

  async function persistLedger() {
    if (!state.dirty) return
    try {
      state.ledger.meta = { ...(state.ledger.meta ?? {}), brainAgentId: state.brainAgentId, savedAt: nowMs() }
      await mkdir(cfg.stateDir, { recursive: true })
      const temporary = `${ledgerPath}.tmp`
      await writeFile(temporary, JSON.stringify(state.ledger, null, 2), 'utf8')
      // Rename is atomic, so a crash mid-write cannot leave a truncated ledger.
      await rename(temporary, ledgerPath)
      state.dirty = false
    } catch (error) {
      warn('could not persist the ledger; continuing in memory', error)
    }
  }

  const touch = () => { state.dirty = true }

  // ---------------------------------------------------------------------------
  // notices to the brain
  // ---------------------------------------------------------------------------

  /** @returns {object | undefined} the live agent that owns this fleet. */
  function resolveBrain() {
    if (!state.brainAgentId) return undefined
    try {
      return ctx.get?.('agents')?.get?.(state.brainAgentId)
    } catch { return undefined }
  }

  /** Remember which agent is driving the fleet, so notices survive a restart. */
  function rememberBrain(exec) {
    const agent = exec?.agent
    if (!agent?.id || state.brainAgentId === agent.id) return
    state.brainAgentId = String(agent.id)
    touch()
  }

  /**
   * Record a notice and, when possible, deliver it to the brain immediately.
   *
   * `steer` is the one verb that works whatever the brain is doing: it starts a
   * turn when the brain is idle and reaches a running turn at its next step
   * boundary. `inject` alone would leave an idle brain asleep with a queued
   * notice it never reads.
   *
   * @param {string} text - the full notice body.
   * @param {string} summary - one-line account, required by `form: 'notice'`.
   * @returns {void}
   */
  function notify(text, summary) {
    pushBounded(state.ledger.notices, { at: nowMs(), summary: truncateHead(summary, 160), text: truncate(text, 2000) }, 20)
    touch()
    if (!cfg.liveNotices) return
    const agent = resolveBrain()
    if (!agent?.steer) return
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: truncate(text, 2000) }],
        source: { kind: 'plugin', plugin: 'herdr-fleet', form: 'notice', summary: truncateHead(summary, 160) },
      }))
    } catch (error) {
      warn('live notice delivery failed; the notice stays queued for fleet_status', error)
    }
  }

  // ---------------------------------------------------------------------------
  // fleet operations
  // ---------------------------------------------------------------------------

  /** @returns {object[]} the agents Herdr is currently reporting. */
  function currentAgents() {
    return normalizeAgents(state.lastSnapshot ?? {})
  }

  /**
   * Read one agent's rendered output tail. `agent read` prints terminal text,
   * not JSON, so the raw stdout is the answer.
   * @param {string} target @param {number} [lines]
   * @returns {Promise<string>}
   */
  async function readTail(target, lines) {
    const result = await herdrQuiet(
      `agent read ${quoteArg(target, cfg.flavor)} --source recent-unwrapped --lines ${Math.max(1, Math.floor(lines ?? cfg.readLines))}`,
    )
    if (result?.error) return ''
    return result.stdout ?? ''
  }

  /**
   * Interrupt an agent: Esc clears a modal, Ctrl+C interrupts the turn.
   * @param {string} target @returns {Promise<{halted: boolean, errors: string[]}>}
   */
  async function haltAgent(target) {
    const errors = []
    for (const key of ['esc', 'ctrl+c']) {
      const result = await herdrQuiet(`agent send-keys ${quoteArg(target, cfg.flavor)} ${key}`)
      if (result?.error) errors.push(`${key}: ${result.error}`)
    }
    return { halted: errors.length < 2, errors }
  }

  /**
   * Capture where an agent left off, at the moment it is halted.
   * @param {object} agent @param {string} reason @param {string} tail @param {string} [taskHint]
   * @returns {object} the stored handoff record.
   */
  function captureHandoff(agent, reason, tail, taskHint) {
    const record = makeHandoff({
      id: makeId('ho', nowMs()),
      at: nowMs(),
      from: agent.name,
      kind: agent.kind,
      paneId: agent.paneId,
      workspaceId: agent.workspaceId,
      reason,
      taskHint: taskHint ?? '',
      tail,
    })
    pushBounded(state.ledger.handoffs, record, 10)
    touch()
    return record
  }

  // ---------------------------------------------------------------------------
  // the watcher
  // ---------------------------------------------------------------------------

  /** One poll: refresh the roster, accrue meters, and enforce the two limits. */
  async function tick() {
    const at = nowMs()
    const elapsedMs = state.lastTickMs > 0 ? clamp(at - state.lastTickMs, 0, 5 * cfg.tickMs) : cfg.tickMs
    state.lastTickMs = at
    state.tickCount += 1

    let snapshot
    try {
      snapshot = await herdrJson('api snapshot')
      if (state.reachable === false) {
        notify('herdr-fleet: the Herdr server is reachable again; metering has resumed.', 'herdr reachable again')
      }
      state.reachable = true
      state.lastError = ''
    } catch (error) {
      state.reachable = false
      state.lastError = String(error?.message ?? error)
      // Announce the transition once, not once per tick.
      if (state.tickCount === 1 || state.lastError !== state.ledger.meta?.lastHerdrError) {
        notify(
          `herdr-fleet: \`herdr api snapshot\` failed — ${state.lastError}\n`
          + 'Is the Herdr server running? Metering is paused until it answers.',
          'herdr unreachable',
        )
        state.ledger.meta = { ...(state.ledger.meta ?? {}), lastHerdrError: state.lastError }
        touch()
      }
      await fireDueParks(at)
      await persistLedger()
      return
    }
    state.ledger.meta = { ...(state.ledger.meta ?? {}), lastHerdrError: '' }
    state.lastSnapshot = snapshot

    const agents = normalizeAgents(snapshot)
    for (const agent of agents) {
      const entry = meterEntry(state.ledger.meter, agent.name, agent.kind)
      if (accrueWorking(entry, agent.status, at, elapsedMs)) touch()

      // Blocked agents need a person. That is a visibility event, not a halt.
      if (cfg.notifyOnBlocked && agent.status === 'blocked' && !state.blockedSeen[agent.name]) {
        state.blockedSeen[agent.name] = true
        notify(
          `herdr-fleet: agent \`${agent.name}\` (${agent.kind}) is blocked on an approval or question prompt.\n`
          + `Attach to its pane to answer it:  herdr agent focus ${agent.name}\n`
          + 'Its budget clock is not accruing while it waits.',
          `${agent.name} blocked on a prompt`,
        )
      } else if (agent.status !== 'blocked') {
        delete state.blockedSeen[agent.name]
      }

      if (agent.status !== 'working') {
        // Herdr has reflected the interrupt (or the agent finished): the halt
        // mark has done its job and a future exhaustion may halt it again.
        delete state.halted[agent.name]
        continue
      }

      // Already halted, and Herdr has not yet reported the interrupt. Sending
      // Esc/Ctrl+C again would duplicate the halt, and every extra pass would
      // capture another identical handoff and steer another notice.
      const held = state.halted[agent.name]
      if (held && at - held.at < cfg.haltSettleMs) continue

      // 1. Budget ceiling.
      const used = usedMs(entry, at, cfg.windowMs)
      const budget = budgetFor(state.ledger.budgets, agent.name, cfg.budgetMs)
      if (used >= budget) {
        if (cfg.autoHalt) {
          const tail = await readTail(agent.name)
          const outcome = await haltAgent(agent.name)
          state.halted[agent.name] = { at, reason: 'budget' }
          const record = captureHandoff(agent, `${hours(budget)}h budget exhausted inside the rolling ${hours(cfg.windowMs)}h window`, tail)
          notify(
            `herdr-fleet: agent \`${agent.name}\` (${agent.kind}) reached its ${hours(budget)}h budget and was halted.\n`
            + `Handoff snapshot \`${record.id}\` captures where it left off.\n`
            + `Continue it elsewhere:  fleet_handoff handoff_id=${record.id} to_kind=<kind>\n`
            + `Or override the ceiling:  fleet_config name=${agent.name} budget_hours=<hours>`
            + (outcome.errors.length > 0 ? `\n(halt warnings: ${outcome.errors.join('; ')})` : ''),
            `${agent.name} budget exhausted; handoff ${record.id}`,
          )
        }
        continue
      }

      // 2. Provider throttling, confirmed across scans before acting.
      if (state.tickCount % cfg.readEveryTicks !== 0) continue
      const tail = await readTail(agent.name)
      const rl = state.ledger.rl[agent.name] ?? (state.ledger.rl[agent.name] = { streak: 0, lastFiredMs: 0, lastHash: '' })
      const step = rateLimitStep(rl, tail, { confirmScans: cfg.rlConfirmScans, cooldownMs: cfg.rlCooldownMs }, at)
      touch()
      if (!step.hit || !cfg.autoHalt) continue

      const outcome = await haltAgent(agent.name)
      state.halted[agent.name] = { at, reason: 'rate-limit' }
      const record = captureHandoff(agent, 'provider rate limit (429 / quota / throttle)', tail)
      notify(
        `herdr-fleet: agent \`${agent.name}\` (${agent.kind}) is stalled on a provider rate limit and was halted.\n`
        + `Handoff snapshot \`${record.id}\` captures where it left off.\n`
        + `Continue the work elsewhere:  fleet_handoff handoff_id=${record.id} to_kind=<kind>\n`
        + `Or wait out the provider window:  fleet_park name=${agent.name} minutes=30`
        + (outcome.errors.length > 0 ? `\n(halt warnings: ${outcome.errors.join('; ')})` : ''),
        `${agent.name} rate-limited; handoff ${record.id}`,
      )
    }

    await fireDueParks(at)
    await persistLedger()
  }

  /**
   * Resume agents whose park has come due, and drop the ones that came due
   * while dsh was not running.
   * @param {number} at @returns {Promise<void>}
   */
  async function fireDueParks(at) {
    if (state.ledger.parks.length === 0) return
    const { due, stale, pending } = splitParks(state.ledger.parks, at, cfg.staleParkGraceMs)
    if (due.length === 0 && stale.length === 0) return
    state.ledger.parks = pending

    for (const park of stale) {
      notify(
        `herdr-fleet: the parked resume for \`${park.name}\` came due while dsh was not running, so it was dropped rather than sent late.\n`
        + `Prompt it directly if it still needs to continue:  fleet_prompt name=${park.name}`,
        `${park.name} park expired unspent`,
      )
    }
    for (const park of due) {
      const prompt = `Your parked pause is over. Note from the orchestrator: ${park.note}. Continue your previous task from where you stopped.`
      const result = await herdrQuiet(`agent prompt ${quoteArg(park.name, cfg.flavor)} ${shellTextArg(prompt, cfg.flavor)}`)
      notify(
        `herdr-fleet: park expired for \`${park.name}\` — resume prompt sent.`
        + (result?.error ? `\nDelivery failed: ${result.error}` : ''),
        `${park.name} resumed from park`,
      )
    }
    touch()
  }

  // ---------------------------------------------------------------------------
  // tools
  // ---------------------------------------------------------------------------

  /** A JSON tool result: schema for the value, renderer for the model text. */
  const jsonOutput = (render) => ({
    schema: { type: 'json' },
    render: (args, value) => [{ type: 'text', text: render(args, clean(value)) }],
  })

  /**
   * Strip `undefined` members, recursively.
   *
   * Tool values are validated against `output.schema` and carried as JSON, which
   * has no `undefined`: an optional field built as `x || undefined` would be a
   * real member holding a non-JSON value. Building results with `undefined` for
   * "absent" is the natural way to write these branches, so the conversion
   * happens here, once, instead of at every return site.
   * @param {unknown} value @returns {unknown}
   */
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean)
    if (value !== null && typeof value === 'object') {
      const output = {}
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) output[key] = clean(entry)
      }
      return output
    }
    return value
  }

  /**
   * Wrap a tool so its result is always lossless JSON.
   * @param {object} tool @returns {object}
   */
  const cleanTool = (tool) => ({
    ...tool,
    async execute(args, exec) { return clean(await tool.execute(args, exec)) },
  })

  const asText = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```'

  const tools = [
    defineTool({
      name: 'fleet_status',
      description:
        'Fleet overview: every Herdr agent with its live status, meter usage against its budget, '
        + 'pending handoff snapshots, parked resumes, and recent notices. Poll this after a fleet notice.',
      parameters: {},
      output: jsonOutput((_args, value) => renderStatus(value)),
      async execute(_args, exec) {
        rememberBrain(exec)
        if (!state.reachable || state.lastSnapshot === null) {
          // A status call is the natural place to recover from a missed poll.
          try {
            state.lastSnapshot = await herdrJson('api snapshot')
            state.reachable = true
            state.lastError = ''
          } catch (error) {
            state.reachable = false
            state.lastError = String(error?.message ?? error)
          }
        }
        await persistLedger()
        return statusView({
          agents: currentAgents(),
          meter: state.ledger.meter,
          budgets: state.ledger.budgets,
          defaultBudgetMs: cfg.budgetMs,
          windowMs: cfg.windowMs,
          now: nowMs(),
          handoffs: state.ledger.handoffs,
          notices: state.ledger.notices,
          parks: state.ledger.parks,
          reachable: state.reachable,
          lastError: state.lastError || undefined,
        })
      },
    }),

    defineTool({
      name: 'fleet_read',
      description: "Read one Herdr agent's recent terminal output. Use it to judge whether an agent is progressing, stuck, or finished.",
      parameters: {
        name: { type: 'string', required: true, description: 'Live agent name.' },
        lines: { type: 'integer', description: 'Trailing lines to read. Defaults to the configured scan depth.' },
      },
      output: jsonOutput((_args, value) => value.text || '(no output)'),
      async execute(args, exec) {
        rememberBrain(exec)
        const text = await readTail(String(args.name), args.lines)
        return { name: String(args.name), lines: Math.max(1, Math.floor(args.lines ?? cfg.readLines)), text: truncate(text, 8000) }
      },
    }),

    defineTool({
      name: 'fleet_dispatch',
      description:
        'Start a new agent in a new Herdr workspace, optionally with its first prompt. '
        + 'Metering begins automatically. The name must match [a-z][a-z0-9_-]{0,31}.',
      parameters: {
        name: { type: 'string', required: true, description: 'Agent name, [a-z][a-z0-9_-]{0,31}, unique among live agents.' },
        kind: { type: 'string', required: true, enum: KINDS, description: 'Agent kind Herdr should launch.' },
        prompt: { type: 'string', description: 'Optional first prompt, sent once the agent is up.' },
        cwd: { type: 'string', description: 'Workspace directory for the new agent.' },
        label: { type: 'string', description: 'Herdr workspace label. Defaults to the agent name.' },
      },
      output: jsonOutput((_args, value) => asText(value)),
      async execute(args, exec) {
        rememberBrain(exec)
        const requested = String(args.name)
        if (!isAgentName(requested)) {
          const suggestion = deriveAgentName(requested, currentAgents().map(agent => agent.name))
          return {
            error: `invalid agent name "${requested}" — Herdr requires [a-z][a-z0-9_-]{0,31}`,
            suggestion,
          }
        }
        const kind = String(args.kind)
        if (!KINDS.includes(kind)) return { error: `unsupported kind "${kind}"`, supported: KINDS }

        const label = String(args.label ?? requested)
        const created = await herdrJson(
          `workspace create --label ${quoteArg(label, cfg.flavor)}`
          + (args.cwd ? ` --cwd ${quoteArg(args.cwd, cfg.flavor)}` : '')
          + ' --no-focus',
        )
        const root = created?.result?.root_pane?.pane_id
        if (!root) return { error: 'workspace create returned no root pane', response: created }

        const started = await herdrJson(`agent start ${requested} --kind ${kind} --pane ${quoteArg(root, cfg.flavor)}`)
        meterEntry(state.ledger.meter, requested, kind)
        touch()

        let prompted = false
        let promptError
        if (args.prompt) {
          const sent = await herdrQuiet(`agent prompt ${requested} ${shellTextArg(args.prompt, cfg.flavor)}`, { timeoutMs: 60_000 })
          prompted = !sent?.error
          promptError = sent?.error
        }
        await persistLedger()
        return {
          name: requested,
          kind,
          paneId: String(root),
          workspaceId: String(created?.result?.workspace?.workspace_id ?? ''),
          started: started?.result ? true : undefined,
          prompted,
          promptError,
        }
      },
    }),

    defineTool({
      name: 'fleet_prompt',
      description:
        'Send a prompt to a running fleet agent. Warns but does not block when the agent is at or over its budget.',
      parameters: {
        name: { type: 'string', required: true, description: 'Live agent name or its pane id.' },
        prompt: { type: 'string', required: true, description: 'Text to deliver.' },
        wait: { type: 'boolean', description: 'Wait for the agent to settle before returning.' },
        timeoutMs: { type: 'integer', description: 'Settle-wait bound in milliseconds.' },
      },
      output: jsonOutput((_args, value) => asText(value)),
      timeoutMs: WAIT_TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        rememberBrain(exec)
        const target = String(args.name)
        const entry = state.ledger.meter[target]
        const used = entry ? usedMs(entry, nowMs(), cfg.windowMs) : 0
        const budget = budgetFor(state.ledger.budgets, target, cfg.budgetMs)
        const timeoutMs = clamp(Number(args.timeoutMs) || 60_000, 5_000, WAIT_TOOL_TIMEOUT_MS - 5_000)
        const command = `agent prompt ${quoteArg(target, cfg.flavor)} ${shellTextArg(args.prompt, cfg.flavor)}`
          + (args.wait ? ` --wait --timeout ${timeoutMs}` : '')
        const result = await herdrQuiet(command, { timeoutMs: args.wait ? timeoutMs + 5000 : 60_000 })
        if (result?.error) return { name: target, prompted: false, error: result.error }
        return {
          name: target,
          prompted: true,
          settled: args.wait ? true : undefined,
          overBudget: used >= budget || undefined,
          usedHours: hours(used),
          budgetHours: hours(budget),
        }
      },
    }),

    defineTool({
      name: 'fleet_handoff',
      description:
        'Continue a captured handoff snapshot on another agent: sends the continuation prompt carrying where the halted agent left off. '
        + 'Either target an existing agent (to_name) or start a fresh one (to_kind).',
      parameters: {
        handoff_id: { type: 'string', required: true, description: 'Handoff id from a fleet notice or fleet_status.' },
        to_name: { type: 'string', description: 'Existing live agent to continue the work.' },
        to_kind: { type: 'string', enum: KINDS, description: 'Kind for a fresh agent when to_name is absent.' },
        cwd: { type: 'string', description: 'Workspace directory for a fresh agent.' },
      },
      output: jsonOutput((_args, value) => asText(value)),
      async execute(args, exec) {
        rememberBrain(exec)
        const id = String(args.handoff_id)
        const record = state.ledger.handoffs.find(candidate => candidate.id === id)
        if (!record) {
          return { error: `no pending handoff "${id}"`, pending: state.ledger.handoffs.map(item => item.id) }
        }
        if (!args.to_name && !args.to_kind) {
          return { error: 'give either to_name (an existing agent) or to_kind (to start a fresh one)' }
        }

        let target = args.to_name ? String(args.to_name) : ''
        if (!target) {
          const fresh = deriveAgentName(`cont-${record.from}`, currentAgents().map(agent => agent.name))
          const created = await herdrJson(
            `workspace create --label ${quoteArg(fresh, cfg.flavor)}`
            + (args.cwd ? ` --cwd ${quoteArg(args.cwd, cfg.flavor)}` : '')
            + ' --no-focus',
          )
          const root = created?.result?.root_pane?.pane_id
          if (!root) return { error: 'workspace create returned no root pane', response: created }
          await herdrJson(`agent start ${fresh} --kind ${String(args.to_kind)} --pane ${quoteArg(root, cfg.flavor)}`)
          meterEntry(state.ledger.meter, fresh, String(args.to_kind))
          target = fresh
        }

        const sent = await herdrQuiet(
          `agent prompt ${quoteArg(target, cfg.flavor)} ${shellTextArg(continuationPrompt(record), cfg.flavor)}`,
          { timeoutMs: 60_000 },
        )
        if (sent?.error) return { handoff: id, from: record.from, to: target, dispatched: false, error: sent.error }

        record.consumedAt = nowMs()
        record.to = target
        state.ledger.handoffs = state.ledger.handoffs.filter(candidate => candidate.id !== id)
        pushBounded(state.ledger.notices, {
          at: nowMs(),
          summary: `handoff ${id}: ${record.from} -> ${target}`,
          text: `Handoff ${id} dispatched from ${record.from} to ${target}.`,
        }, 20)
        touch()
        await persistLedger()
        return { handoff: id, from: record.from, to: target, dispatched: true, reason: record.reason }
      },
    }),

    defineTool({
      name: 'fleet_park',
      description:
        'Park an agent: schedule a resume prompt after N minutes. Preferable to a handoff when waiting out a provider rate-limit window is cheaper than restarting the work.',
      parameters: {
        name: { type: 'string', required: true, description: 'Live agent name.' },
        minutes: { type: 'integer', required: true, description: 'Delay before the resume prompt (1-720).' },
        note: { type: 'string', description: 'Note included in the resume prompt.' },
      },
      output: jsonOutput((_args, value) => asText(value)),
      async execute(args, exec) {
        rememberBrain(exec)
        const target = String(args.name)
        const minutes = clamp(Math.floor(Number(args.minutes) || 15), 1, 720)
        const park = {
          name: target,
          fireAtMs: nowMs() + minutes * 60_000,
          note: String(args.note ?? 'resume your previous task'),
        }
        state.ledger.parks = state.ledger.parks.filter(existing => existing.name !== target)
        state.ledger.parks.push(park)
        touch()
        await persistLedger()
        return { name: target, minutes, resumesInMinutes: round2(minutes), note: park.note }
      },
    }),

    defineTool({
      name: 'fleet_halt',
      description:
        'Halt a fleet agent immediately (Esc then Ctrl+C) and capture where it left off as a pending handoff.',
      parameters: {
        name: { type: 'string', required: true, description: 'Live agent name.' },
        reason: { type: 'string', description: 'Why the agent is being halted; recorded on the handoff.' },
      },
      output: jsonOutput((_args, value) => asText(value)),
      async execute(args, exec) {
        rememberBrain(exec)
        const target = String(args.name)
        const agent = currentAgents().find(candidate => candidate.name === target)
        const tail = await readTail(target)
        const outcome = await haltAgent(target)
        const record = captureHandoff(
          { name: target, kind: agent?.kind ?? state.ledger.meter[target]?.kind ?? 'unknown', paneId: agent?.paneId ?? '', workspaceId: agent?.workspaceId ?? '' },
          `halted on request: ${String(args.reason ?? 'no reason given')}`,
          tail,
        )
        await persistLedger()
        return { name: target, halted: outcome.halted, warnings: outcome.errors.length > 0 ? outcome.errors : undefined, handoff: record.id }
      },
    }),

    defineTool({
      name: 'fleet_wait',
      description:
        'Wait until an agent reaches a settled Herdr status (idle, done, or blocked), or the timeout expires. '
        + 'Use it to sequence work instead of polling fleet_status in a loop.',
      parameters: {
        name: { type: 'string', required: true, description: 'Live agent name or its pane id.' },
        until: {
          type: 'array',
          items: { type: 'string', enum: AGENT_STATUSES },
          description: 'Statuses that end the wait. Defaults to idle, done, and blocked.',
        },
        timeoutMs: { type: 'integer', description: 'Wait bound in milliseconds (5000-115000).' },
      },
      output: jsonOutput((_args, value) => asText(value)),
      timeoutMs: WAIT_TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        rememberBrain(exec)
        const target = String(args.name)
        const until = Array.isArray(args.until) && args.until.length > 0 ? args.until : ['idle', 'done', 'blocked']
        const timeoutMs = clamp(Number(args.timeoutMs) || 60_000, 5_000, WAIT_TOOL_TIMEOUT_MS - 5_000)
        const untilArgs = until.map(status => `--until ${quoteArg(status, cfg.flavor)}`).join(' ')
        const result = await herdrQuiet(
          `agent wait ${quoteArg(target, cfg.flavor)} ${untilArgs} --timeout ${timeoutMs}`,
          { timeoutMs: timeoutMs + 5000 },
        )
        if (result?.error) return { name: target, settled: false, error: result.error, until, timeoutMs }
        const parsed = (() => { try { return JSON.parse(result.stdout) } catch { return undefined } })()
        const status = parsed?.result?.status ?? parsed?.status
        return { name: target, settled: true, status: status ? String(status) : undefined, until, timeoutMs }
      },
    }),

    defineTool({
      name: 'fleet_config',
      description:
        'Read or set per-agent meter budgets in hours. Without name and budget_hours it returns the current budget map.',
      parameters: {
        name: { type: 'string', description: 'Agent name whose budget to set.' },
        budget_hours: { type: 'number', description: 'New budget in hours for that agent.' },
        reset_meter: { type: 'boolean', description: 'Also clear the agent\'s accrued usage.' },
      },
      output: jsonOutput((_args, value) => asText(value)),
      async execute(args, exec) {
        rememberBrain(exec)
        if (args.name === undefined && args.budget_hours === undefined) {
          return {
            defaultBudgetHours: hours(cfg.budgetMs),
            windowHours: hours(cfg.windowMs),
            overrides: state.ledger.budgets,
            stateDir: cfg.stateDir,
          }
        }
        const target = String(args.name ?? '')
        if (!target) return { error: 'name is required when budget_hours is given' }
        if (args.budget_hours !== undefined) {
          const value = Number(args.budget_hours)
          if (!Number.isFinite(value) || value <= 0) return { error: 'budget_hours must be a positive number' }
          state.ledger.budgets[target] = Math.round(value * 3_600_000)
        }
        if (args.reset_meter) {
          if (state.ledger.meter[target]) state.ledger.meter[target].chunks = []
          state.ledger.rl[target] = { streak: 0, lastFiredMs: 0, lastHash: '' }
        }
        touch()
        await persistLedger()
        return {
          name: target,
          budgetHours: hours(budgetFor(state.ledger.budgets, target, cfg.budgetMs)),
          usedHours: hours(state.ledger.meter[target] ? usedMs(state.ledger.meter[target], nowMs(), cfg.windowMs) : 0),
          meterReset: args.reset_meter === true || undefined,
        }
      },
    }),

    defineTool({
      name: 'fleet_probe',
      description:
        "Ask the local Herdr binary to describe itself: version and, when available, the JSON schema of its `session.snapshot` response. "
        + 'Use it to confirm the snapshot field names this plugin reads, when agents stop showing up in fleet_status.',
      parameters: {},
      output: jsonOutput((_args, value) => asText(value)),
      async execute(_args, exec) {
        rememberBrain(exec)
        const version = await herdrQuiet('--version')
        const schema = await herdrQuiet('api schema --json', { timeoutMs: 60_000 })
        const parsed = (() => { try { return JSON.parse(schema?.stdout ?? '') } catch { return undefined } })()
        const agentKeys = parsed ? findAgentRecordKeys(parsed) : []
        return {
          herdrBin: cfg.herdrBin,
          version: version?.error ? undefined : truncate(version.stdout, 200).trim(),
          versionError: version?.error,
          schemaAvailable: Boolean(parsed),
          schemaError: parsed ? undefined : (schema?.error ?? 'api schema did not print JSON'),
          detectedAgentRecordKeys: agentKeys,
          agentsVisibleNow: currentAgents().length,
        }
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(cleanTool(tool))

  // ---------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------

  ctx.effect(() => {
    let disposed = false
    loadLedger().then(() => {
      if (!disposed) touch()
    }).catch(error => warn('ledger load failed', error))
    return () => { disposed = true }
  })

  // The watcher needs the shell (to reach herdr) and the timer (for its cadence).
  // Acquiring both as runtime dependencies keeps this plugin loadable — with its
  // tools usable — in a profile that mounts only one of them.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shell', 'timer'], (timerCtx) => {
      let ticking = false
      timerCtx.setInterval(() => {
        // An interval callback does not await its predecessor. Without this
        // guard a poll slower than the cadence would overlap the next one, and
        // two snapshots in flight would double-count the same wall-clock
        // interval against every agent's budget.
        if (ticking) return undefined
        ticking = true
        // The promise is returned for callers that drive the tick directly
        // (tests, and any host that awaits its timer callback); a real timer
        // ignores it.
        return tick().catch(error => warn('watcher tick failed', error)).finally(() => { ticking = false })
      }, cfg.tickMs)
    })
  } else {
    warn('ctx.inject is unavailable, so the budget watcher was not started; the fleet_* tools still work')
  }
}

/**
 * Best-effort discovery of the snapshot's agent-record field names from
 * `herdr api schema --json`, so `fleet_probe` can tell an operator what the
 * binary actually emits instead of guessing.
 * @param {unknown} schema @returns {string[]}
 */
function findAgentRecordKeys(schema) {
  const found = new Set()
  const visit = (node, depth) => {
    if (depth > 12 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const properties = node.properties
    if (properties && typeof properties === 'object') {
      if ('agent_status' in properties || 'agent' in properties || 'pane_id' in properties) {
        for (const key of Object.keys(properties)) found.add(key)
      }
      visit(properties, depth + 1)
    }
    for (const value of Object.values(node)) visit(value, depth + 1)
  }
  visit(schema, 0)
  return [...found].sort()
}
