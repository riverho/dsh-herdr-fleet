// Behaviour tests for plugin/index.js: booted against a fake ctx and a
// scriptable herdr CLI in test/harness.mjs.
import { bootPlugin, check, checkEqual, clock, makeWorld, section } from './harness.mjs'

clock.install()

const SECOND = 1000
const TICK_MS = 10 * SECOND

/** Advance the clock one watcher interval and run one tick. */
async function tick(boot, ms = TICK_MS) {
  clock.advance(ms)
  await boot.runTick()
}

/** Assert a value contains no `undefined` anywhere (tool results must be JSON). */
function hasUndefined(value, seen = new Set()) {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  for (const entry of Object.values(value)) if (hasUndefined(entry, seen)) return true
  return false
}

/**
 * Bind the fleet's brain the way real usage does: the owning agent calls a
 * fleet tool. Live notices require a bound brain; without one they queue for
 * `fleet_status` instead.
 */
async function bindBrain(boot) {
  await boot.callTool('fleet_status')
}

// ------------------------------- tool surface --------------------------------
section('tool registration')

{
  const boot = await bootPlugin()
  checkEqual(
    'registers the full fleet tool surface',
    [...boot.registered.keys()].sort(),
    ['fleet_config', 'fleet_dispatch', 'fleet_halt', 'fleet_handoff', 'fleet_park', 'fleet_probe', 'fleet_prompt', 'fleet_read', 'fleet_status', 'fleet_wait'],
  )
  check('watcher started on the configured cadence', boot.timer.ms === TICK_MS)
  checkEqual('watcher is acquired as a runtime dependency', boot.timer.injections, [['shell', 'timer']])
  checkEqual('nothing warned during load', boot.warnings, [])
  boot.cleanup()
}

{
  const boot = await bootPlugin({ withInject: false })
  check('loads without ctx.inject', boot.registered.size === 10)
  check('warns that the watcher is unavailable', boot.warnings.some(line => line.includes('watcher')), boot.warnings.join(' | '))
  boot.cleanup()
}

// --------------------------------- metering ----------------------------------
section('metering and budget enforcement')

{
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'working', paneId: 'p1' }] })
  const boot = await bootPlugin({ world, config: { budgetHours: 0.01, readEveryTicks: 999 } })
  await bindBrain(boot)

  await tick(boot)
  const afterFirst = boot.readLedgerOrNull()
  check('first tick does not credit time', (afterFirst?.meter?.alpha?.chunks?.length ?? 0) === 0)

  await tick(boot)
  const afterTwo = boot.readLedger()
  checkEqual('second tick credits one interval', afterTwo.meter.alpha.chunks.length, 1)

  // 0.01h = 36s. Ticks credit 10s each from the second onward.
  for (let i = 0; i < 3; i++) await tick(boot)

  const keys = world.keys.filter(entry => entry.name === 'alpha').map(entry => entry.key)
  check('budget exhaustion sends esc', keys.includes('esc'))
  check('budget exhaustion sends ctrl+c', keys.includes('ctrl+c'))

  const ledger = boot.readLedger()
  checkEqual('exactly one handoff was captured', ledger.handoffs.length, 1)
  check('handoff reason names the budget', /budget/i.test(ledger.handoffs[0].reason), ledger.handoffs[0].reason)
  check('handoff records the source agent', ledger.handoffs[0].from === 'alpha')
  check('brain was steered', boot.brain.steers.length >= 1)
  check('notice names the handoff id', boot.brain.steers.some(m => m.content[0].text.includes(ledger.handoffs[0].id)))
  check('notice declares the notice form', boot.brain.steers[0].source.form === 'notice')
  check('notice carries a summary', typeof boot.brain.steers[0].source.summary === 'string' && boot.brain.steers[0].source.summary.length > 0)
  boot.cleanup()
}

{
  // A halted agent must not be halted again on every subsequent tick. The fake
  // Herdr deliberately keeps reporting `working` after the interrupt here.
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'working' }] })
  const boot = await bootPlugin({ world, config: { budgetHours: 0.01, readEveryTicks: 999 } })
  await bindBrain(boot)
  for (let i = 0; i < 6; i++) await tick(boot)
  const escCount = world.keys.filter(entry => entry.key === 'esc').length
  check('an exhausted agent is halted once, not per tick', escCount === 1, `esc sent ${escCount} times`)
  checkEqual('only one handoff is captured', boot.readLedger().handoffs.length, 1)
  checkEqual('only one notice is raised', boot.brain.steers.length, 1)

  // Once Herdr reflects the interrupt, the guard releases...
  world.setStatus('alpha', 'idle')
  await tick(boot)
  // ...so a genuinely resumed agent that exhausts its budget again is halted again.
  world.setStatus('alpha', 'working')
  await tick(boot)
  await tick(boot)
  const escAfterResume = world.keys.filter(entry => entry.key === 'esc').length
  check('a resumed agent can be halted again', escAfterResume === 2, `esc sent ${escAfterResume} times`)
  boot.cleanup()
}

{
  // autoHalt: false observes and warns only.
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'working' }] })
  const boot = await bootPlugin({ world, config: { budgetHours: 0.01, autoHalt: false, readEveryTicks: 999 } })
  for (let i = 0; i < 5; i++) await tick(boot)
  checkEqual('autoHalt:false sends no keys', world.keys.length, 0)
  checkEqual('autoHalt:false captures no handoff', boot.readLedger().handoffs.length, 0)
  boot.cleanup()
}

{
  // An idle agent's budget must not accrue.
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'idle' }] })
  const boot = await bootPlugin({ world, config: { budgetHours: 0.001, readEveryTicks: 999 } })
  for (let i = 0; i < 6; i++) await tick(boot)
  const idleLedger = boot.readLedgerOrNull()
  checkEqual('an idle agent accrues nothing', idleLedger?.meter?.alpha?.chunks?.length ?? 0, 0)
  checkEqual('an idle agent is never halted', world.keys.length, 0)
  check('an idle agent does not dirty the ledger', idleLedger === null || Object.keys(idleLedger.meter).every(name => idleLedger.meter[name].chunks.length === 0))
  boot.cleanup()
}

// ------------------------------ rate limiting --------------------------------
section('rate-limit detection and handoff')

{
  const world = makeWorld({
    agents: [{ name: 'alpha', kind: 'claude', status: 'working', paneId: 'p1' }],
    tails: { alpha: 'Working...\nError: 429 Too Many Requests — retry after 60s' },
  })
  const boot = await bootPlugin({ world, config: { rlConfirmScans: 2 } })
  await bindBrain(boot)

  await tick(boot)
  checkEqual('one throttled scan does not halt', world.keys.length, 0)
  await tick(boot)

  const keys = world.keys.map(entry => entry.key)
  check('a confirmed rate limit halts the agent', keys.includes('esc') && keys.includes('ctrl+c'))

  const ledger = boot.readLedger()
  checkEqual('a handoff was captured', ledger.handoffs.length, 1)
  check('handoff reason names the rate limit', /rate limit/i.test(ledger.handoffs[0].reason), ledger.handoffs[0].reason)
  check('handoff tail contains where it left off', ledger.handoffs[0].outputTail.includes('429'))
  check('the model was told, with the handoff id', boot.brain.steers.some(m => m.content[0].text.includes(ledger.handoffs[0].id)))
  boot.cleanup()
}

{
  // Ordinary output must never halt an agent.
  const world = makeWorld({
    agents: [{ name: 'alpha', kind: 'claude', status: 'working' }],
    tails: { alpha: 'Compiling...\nTests passed: 128' },
  })
  const boot = await bootPlugin({ world, config: { rlConfirmScans: 1 } })
  for (let i = 0; i < 4; i++) await tick(boot)
  checkEqual('clean output sends no keys', world.keys.length, 0)
  boot.cleanup()
}

// --------------------------------- handoff -----------------------------------
section('handoff continuation')

{
  const world = makeWorld({
    agents: [{ name: 'alpha', kind: 'claude', status: 'working', paneId: 'p1' }],
    tails: { alpha: 'step 1 done\nstep 2 half-written: function parse(' },
  })
  const boot = await bootPlugin({ world })

  const halted = await boot.callTool('fleet_halt', { name: 'alpha', reason: 'moving to a faster model' })
  check('halt returns a handoff id', typeof halted.handoff === 'string')

  const handed = await boot.callTool('fleet_handoff', { handoff_id: halted.handoff, to_kind: 'codex' })
  check('handoff reports success', handed.dispatched === true, JSON.stringify(handed))
  checkEqual('handoff started a continuation agent', handed.to, 'cont-alpha')

  const prompt = world.prompts.at(-1)
  check('continuation went to the new agent', prompt.name === handed.to)
  check('continuation carries where it left off', prompt.text.includes('step 2 half-written'))
  check('continuation names the reason', prompt.text.includes('moving to a faster model'))
  check('continuation forbids redoing finished work', /Do not redo/.test(prompt.text))
  checkEqual('the handoff is consumed', boot.readLedger().handoffs.length, 0)
  boot.cleanup()
}

{
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'idle' }, { name: 'beta', kind: 'codex', status: 'idle' }] })
  const boot = await bootPlugin({ world })
  const halted = await boot.callTool('fleet_halt', { name: 'alpha' })
  const handed = await boot.callTool('fleet_handoff', { handoff_id: halted.handoff, to_name: 'beta' })
  check('handoff can target an existing agent', handed.to === 'beta' && handed.dispatched === true)
  check('the existing agent received the prompt', world.prompts.at(-1).name === 'beta')
  boot.cleanup()
}

{
  const boot = await bootPlugin()
  const missing = await boot.callTool('fleet_handoff', { handoff_id: 'nope', to_kind: 'codex' })
  check('an unknown handoff is refused', typeof missing.error === 'string' && missing.error.includes('nope'))
  const noTarget = await boot.callTool('fleet_handoff', { handoff_id: 'nope' })
  check('a missing target is reported', typeof noTarget.error === 'string')
  boot.cleanup()
}

// ---------------------------- dispatch and prompt ----------------------------
section('dispatch and prompt')

{
  const world = makeWorld()
  const boot = await bootPlugin({ world })
  const dispatched = await boot.callTool('fleet_dispatch', { name: 'beta', kind: 'codex', prompt: 'Refactor the parser' })

  check('a workspace was created', world.workspaces === 1)
  check('the agent was started', world.agents.some(agent => agent.name === 'beta' && agent.kind === 'codex'))
  check('the root pane is reported', dispatched.paneId === 'w1:p1', JSON.stringify(dispatched))
  check('the first prompt was delivered verbatim', world.prompts[0].text === 'Refactor the parser')
  check('metering began immediately', boot.readLedger().meter.beta.kind === 'codex')
  boot.cleanup()
}

{
  const boot = await bootPlugin()
  const bad = await boot.callTool('fleet_dispatch', { name: 'Bad Name', kind: 'codex' })
  check('an invalid name is refused with a suggestion', typeof bad.error === 'string' && typeof bad.suggestion === 'string', JSON.stringify(bad))
  check('the suggestion is a legal name', /^[a-z][a-z0-9_-]{0,31}$/.test(bad.suggestion))
  // The kind enum is enforced by the tool runtime BEFORE execute runs, so an
  // invalid kind never reaches the plugin: it is a ToolArgsError, not a value.
  let rejectedKind = ''
  try {
    await boot.callTool('fleet_dispatch', { name: 'beta', kind: 'not-a-real-agent' })
  } catch (error) {
    rejectedKind = String(error?.message ?? error)
  }
  check('the runtime rejects an unsupported kind at the schema', /must be one of/.test(rejectedKind), rejectedKind || 'no error raised')
  boot.cleanup()
}

{
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'idle' }] })
  const boot = await bootPlugin({ world })
  const result = await boot.callTool('fleet_prompt', { name: 'alpha', prompt: "check the user's config" })
  check('prompt reported delivered', result.prompted === true)
  check('prompt text is exact', world.prompts.at(-1).text === "check the user's config")
  check('an in-budget agent is not flagged', result.overBudget === undefined)
  boot.cleanup()
}

// --------------------------------- parks -------------------------------------
section('parking')

{
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'idle' }] })
  const boot = await bootPlugin({ world })
  const parked = await boot.callTool('fleet_park', { name: 'alpha', minutes: 15, note: 'wait out the 429 window' })
  check('park reports when it resumes', parked.minutes === 15)
  checkEqual('park is persisted', boot.readLedger().parks.length, 1)

  await tick(boot, 5 * 60 * SECOND)
  checkEqual('a park does not fire early', world.prompts.length, 0)

  await tick(boot, 11 * 60 * SECOND)
  check('a park fires once due', world.prompts.length === 1)
  check('the resume prompt carries the note', world.prompts[0].text.includes('wait out the 429 window'))
  checkEqual('a fired park is removed', boot.readLedger().parks.length, 0)
  boot.cleanup()
}

{
  // A park whose moment passed long before the process was running must not fire.
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'idle' }] })
  const boot = await bootPlugin({ world, config: { staleParkGraceMinutes: 30 } })
  await bindBrain(boot)
  await boot.callTool('fleet_park', { name: 'alpha', minutes: 5 })
  await tick(boot, 120 * 60 * SECOND)
  checkEqual('a stale park is dropped, not fired', world.prompts.length, 0)
  check('the drop is explained to the model', boot.brain.steers.some(m => /dropped/.test(m.content[0].text)), JSON.stringify(boot.brain.steers.map(m => m.content[0].text)))
  boot.cleanup()
}

// ------------------------------- resilience ----------------------------------
section('resilience')

{
  const world = makeWorld({ failSnapshot: true })
  const boot = await bootPlugin({ world })
  await tick(boot)
  check('an unreachable herdr does not throw', true)
  const ledger = boot.readLedger()
  checkEqual('one unreachable notice is queued', ledger.notices.filter(n => /unreachable/.test(n.summary)).length, 1)
  await tick(boot)
  checkEqual('the notice is not repeated every tick', boot.readLedger().notices.filter(n => /unreachable/.test(n.summary)).length, 1)

  const status = await boot.callTool('fleet_status')
  check('status reports herdr as unreachable', status.herdrReachable === false, JSON.stringify(status))
  boot.cleanup()
}

{
  const boot = await bootPlugin({ withShell: false })
  const status = await boot.callTool('fleet_status')
  check('a missing shell service is reported, not thrown', status.herdrReachable === false, JSON.stringify(status))
  const read = await boot.callTool('fleet_read', { name: 'alpha' })
  check('reads degrade to empty text without a shell', read.text === '')
  boot.cleanup()
}

{
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'blocked' }] })
  const boot = await bootPlugin({ world })
  await bindBrain(boot)
  await tick(boot)
  checkEqual('a blocked agent is not halted', world.keys.length, 0)
  check('a blocked agent is surfaced to the model', boot.brain.steers.some(m => /blocked/.test(m.content[0].text)))
  check('the notice tells the human which pane to open', boot.brain.steers.some(m => /herdr agent focus/.test(m.content[0].text)))
  checkEqual('a blocked agent accrues no time', boot.readLedger().meter.alpha.chunks.length, 0)
  await tick(boot)
  checkEqual('the blocked notice is not repeated', boot.brain.steers.filter(m => /blocked/.test(m.content[0].text)).length, 1)
  boot.cleanup()
}

{
  // On a fresh install no agent has called a fleet tool yet, so nothing is
  // bound to steer. A notice must queue rather than vanish.
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'blocked' }] })
  const boot = await bootPlugin({ world })
  await tick(boot)
  checkEqual('no live delivery without a bound brain', boot.brain.steers.length, 0)
  const status = await boot.callTool('fleet_status')
  check('the queued notice surfaces in fleet_status', status.recentNotices.some(n => /blocked/.test(n.summary)), JSON.stringify(status.recentNotices))
  check('calling a fleet tool binds the brain', boot.readLedger().meta.brainAgentId === boot.brain.id)
  boot.cleanup()
}

// ------------------------------- persistence ---------------------------------
section('ledger persistence')

{
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'working' }] })
  const boot = await bootPlugin({ world, config: { readEveryTicks: 999 } })
  // Bind the brain first: the binding is part of what must survive a restart.
  await boot.callTool('fleet_status')
  for (let i = 0; i < 3; i++) await tick(boot)
  const used = boot.readLedger().meter.alpha.chunks.length
  check('usage was recorded', used >= 1)
  const stateDir = boot.stateDir

  // Reboot against the same ledger directory: the meter must survive.
  const reboot = await bootPlugin({ world, stateDir, config: { readEveryTicks: 999 } })
  const status = await reboot.callTool('fleet_status')
  check('an agent is present after reboot', status.agents.some(agent => agent.name === 'alpha'))
  check('accrued usage survives a restart', status.agents.find(agent => agent.name === 'alpha').usedHours > 0, JSON.stringify(status.agents))
  check('the brain binding is remembered', reboot.readLedger().meta.brainAgentId === boot.brain.id, JSON.stringify(reboot.readLedger().meta))

  boot.cleanup()
  reboot.cleanup()
}

// -------------------------------- remaining tools ----------------------------
section('remaining tools')

{
  const world = makeWorld({
    agents: [{ name: 'alpha', kind: 'claude', status: 'idle' }],
    tails: { alpha: 'all tests passed' },
  })
  const boot = await bootPlugin({ world })

  const read = await boot.callTool('fleet_read', { name: 'alpha' })
  check('fleet_read returns the tail', read.text === 'all tests passed')

  const configured = await boot.callTool('fleet_config', { name: 'alpha', budget_hours: 2 })
  check('fleet_config sets a budget', configured.budgetHours === 2, JSON.stringify(configured))
  const listed = await boot.callTool('fleet_config', {})
  check('fleet_config lists overrides', listed.overrides.alpha === 2 * 3_600_000)
  const reset = await boot.callTool('fleet_config', { name: 'alpha', reset_meter: true })
  check('fleet_config can reset the meter', reset.meterReset === true)
  const invalid = await boot.callTool('fleet_config', { name: 'alpha', budget_hours: -1 })
  check('fleet_config rejects a negative budget', typeof invalid.error === 'string')

  const waited = await boot.callTool('fleet_wait', { name: 'alpha', timeoutMs: 6000 })
  check('fleet_wait reports the settled status', waited.settled === true && waited.status === 'idle', JSON.stringify(waited))

  const probed = await boot.callTool('fleet_probe', {})
  check('fleet_probe reads the version', probed.version === 'herdr 0.9.1', JSON.stringify(probed))
  check('fleet_probe reports discovered snapshot keys', probed.detectedAgentRecordKeys.includes('agent_status'), JSON.stringify(probed.detectedAgentRecordKeys))
  boot.cleanup()
}

// ------------------------------- result hygiene ------------------------------
section('tool result hygiene')

{
  const world = makeWorld({ agents: [{ name: 'alpha', kind: 'claude', status: 'working' }] })
  const boot = await bootPlugin({ world })
  const calls = [
    ['fleet_status', {}],
    ['fleet_read', { name: 'alpha' }],
    ['fleet_dispatch', { name: 'gamma', kind: 'claude' }],
    ['fleet_prompt', { name: 'alpha', prompt: 'go' }],
    ['fleet_park', { name: 'alpha', minutes: 5 }],
    ['fleet_wait', { name: 'alpha', timeoutMs: 6000 }],
    ['fleet_config', {}],
    ['fleet_probe', {}],
    ['fleet_halt', { name: 'alpha' }],
  ]
  for (const [name, args] of calls) {
    const value = await boot.callTool(name, args)
    check(`${name} returns lossless JSON`, !hasUndefined(value), JSON.stringify(value).slice(0, 200))
    const rendered = boot.renderTool(name, args, value)
    check(`${name} renders text blocks`, Array.isArray(rendered) && rendered.every(block => block.type === 'text' && typeof block.text === 'string'))
  }
  boot.cleanup()
}

clock.restore()
