// Pure-logic tests for plugin/core.mjs. No ctx, no I/O.
import { clock, check, checkEqual, decodePrompt, section } from './harness.mjs'
import {
  accrueWorking, budgetFor, continuationPrompt, deriveAgentName, isAgentName, makeHandoff,
  matchRateLimit, meterEntry, normalizeAgents, quoteArg, rateLimitStep, reviveLedger,
  shellTextArg, splitParks, truncate, usedMs,
} from '../plugin/core.mjs'

// ------------------------------ shell quoting --------------------------------
section('shell quoting')

checkEqual(
  'pwsh prompt round-trips through the decoder',
  decodePrompt(`herdr agent prompt alpha ${shellTextArg("it's a \"test\"\nwith $vars and `ticks`", 'pwsh')}`),
  "it's a \"test\"\nwith $vars and `ticks`",
)

checkEqual(
  'bash prompt round-trips through the decoder',
  decodePrompt(`herdr agent prompt alpha ${shellTextArg('multi\nline $HOME `id`', 'bash')}`),
  'multi\nline $HOME `id`',
)

check('pwsh prompt expression is balanced', (() => {
  const expression = shellTextArg('x', 'pwsh')
  let depth = 0
  let inQuote = false
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]
    if (char === "'") inQuote = !inQuote
    else if (!inQuote && char === '(') depth += 1
    else if (!inQuote && char === ')') depth -= 1
  }
  return depth === 0 && !inQuote
})(), 'the previous revision emitted an unclosed paren')

check('non-ASCII survives base64', decodePrompt(shellTextArg('héllo → 世界 🚀', 'pwsh')) === 'héllo → 世界 🚀')

checkEqual('a plain value is single-quoted', quoteArg('alpha', 'pwsh'), "'alpha'")
checkEqual('pwsh doubles an embedded quote', quoteArg("a'b", 'pwsh'), "'a''b'")
checkEqual('bash closes and reopens around an embedded quote', quoteArg("a'b", 'bash'), "'a'\\''b'")

// ------------------------------ agent naming ---------------------------------
section('agent naming')

check('valid name accepted', isAgentName('alpha-2'))
check('uppercase rejected', !isAgentName('Alpha'))
check('leading digit rejected', !isAgentName('2alpha'))
check('over-long rejected', !isAgentName('a'.repeat(33)))
checkEqual('label folded to a valid name', deriveAgentName('Continue Alpha!'), 'continue-alpha')
checkEqual('leading digit gets a letter prefix', deriveAgentName('9lives'), 'a-9lives')
checkEqual('collision gets a numeric suffix', deriveAgentName('alpha', ['alpha']), 'alpha-2')
checkEqual('suffix respects the 32-char cap', deriveAgentName('a'.repeat(40), ['a'.repeat(32)]).length, 32)

// ------------------------------ snapshot reading -----------------------------
section('snapshot normalization')

checkEqual(
  'reads agents[] with the documented aliases',
  normalizeAgents({ result: { agents: [{ name: 'a1', agent: 'claude', pane_id: 'p1', status: 'working', workspace_id: 'w9' }] } }),
  [{ name: 'a1', kind: 'claude', paneId: 'p1', status: 'working', workspaceId: 'w9', source: 'agents' }],
)

checkEqual(
  'accepts alternative spellings',
  normalizeAgents({ result: { agents: [{ agent_name: 'a2', kind: 'codex', paneId: 'p2', agent_status: 'idle' }] } }),
  [{ name: 'a2', kind: 'codex', paneId: 'p2', status: 'idle', workspaceId: '', source: 'agents' }],
)

checkEqual(
  'falls back to panes[] and drops plain shells',
  normalizeAgents({
    result: {
      panes: [
        { pane_id: 'p1', agent: 'claude', agent_status: 'working' },
        { pane_id: 'p2' },
      ],
    },
  }),
  [{ name: 'p1', kind: 'claude', paneId: 'p1', status: 'working', workspaceId: '', source: 'panes' }],
)

checkEqual('tolerates a snapshot with no agents', normalizeAgents({ result: {} }), [])
checkEqual('tolerates garbage', normalizeAgents(null), [])
checkEqual('deduplicates a name seen twice', normalizeAgents({
  result: { agents: [{ name: 'dup', agent: 'claude', status: 'idle' }], panes: [{ pane_id: 'dup', agent: 'claude', agent_status: 'idle' }] },
}).length, 1)

// ------------------------------- rate limits ---------------------------------
section('rate-limit detection')

for (const phrase of [
  'Error 429: Too Many Requests',
  'You have hit your rate limit. Retry after 30s',
  'quota exceeded for this billing period',
  'API Error: overloaded_error 529',
  'Please try again in 12 minutes',
  'request throttled',
  'weekly limit reached; resets at 3pm',
]) {
  check(`matches: ${truncate(phrase, 40)}`, matchRateLimit(phrase))
}

check('ignores an unrelated 429 substring', !matchRateLimit('wrote 14290 bytes to disk'))
check('ignores a negated mention', !matchRateLimit('rate limiting is disabled for this endpoint'))
check('ignores ordinary output', !matchRateLimit('Compiling 12 modules...\nDone in 3.2s'))

{
  const rl = { streak: 0, lastFiredMs: 0, lastHash: '' }
  const cfg = { confirmScans: 2, cooldownMs: 60_000 }
  const tail = 'rate limit exceeded'
  check('first scan does not fire', !rateLimitStep(rl, tail, cfg, 1000).hit)
  check('second identical scan fires', rateLimitStep(rl, tail, cfg, 2000).hit)
  check('cooldown blocks a repeat', !rateLimitStep(rl, tail, cfg, 3000).hit)
  check('cooldown reports why', rateLimitStep(rl, tail, cfg, 3000).reason === 'cooldown')
  check('clean output resets the streak', (() => {
    rateLimitStep(rl, 'all good', cfg, 4000)
    return rl.streak === 0 && rl.lastHash === ''
  })())
  check('changed output restarts confirmation', (() => {
    const fresh = { streak: 0, lastFiredMs: 0, lastHash: '' }
    rateLimitStep(fresh, 'rate limit A', cfg, 5000)
    const second = rateLimitStep(fresh, 'rate limit B', cfg, 6000)
    return !second.hit && fresh.streak === 1
  })())
}

// -------------------------------- metering -----------------------------------
section('metering')

{
  const meter = {}
  const entry = meterEntry(meter, 'alpha', 'claude')
  check('first observation credits nothing', !accrueWorking(entry, 'working', 1000, 10_000))
  checkEqual('first observation leaves usage at zero', usedMs(entry, 1000, 1e12), 0)
  accrueWorking(entry, 'working', 11_000, 10_000)
  checkEqual('working -> working credits the interval', usedMs(entry, 11_000, 1e12), 10_000)
  accrueWorking(entry, 'idle', 21_000, 10_000)
  checkEqual('working -> idle credits the interval it worked', usedMs(entry, 21_000, 1e12), 20_000)
  accrueWorking(entry, 'idle', 31_000, 10_000)
  checkEqual('idle -> idle credits nothing', usedMs(entry, 31_000, 1e12), 20_000)
}

{
  // `usedMs` prunes in place, so each window gets its own entry.
  const meter = {}
  const bounded = meterEntry(meter, 'a', 'claude')
  bounded.chunks = [[0, 1000], [100_000, 5000]]
  checkEqual('rolling window drops old chunks', usedMs(bounded, 200_000, 150_000), 5000)

  const unbounded = meterEntry(meter, 'b', 'claude')
  unbounded.chunks = [[0, 1000], [100_000, 5000]]
  checkEqual('unbounded window keeps all', usedMs(unbounded, 200_000, 1e12), 6000)
}

checkEqual('budget override wins', budgetFor({ alpha: 60_000 }, 'alpha', 5 * 3_600_000), 60_000)
checkEqual('budget falls back to the default', budgetFor({}, 'alpha', 18_000_000), 18_000_000)
checkEqual('a zero override is not a budget', budgetFor({ alpha: 0 }, 'alpha', 18_000_000), 18_000_000)

// -------------------------------- handoffs -----------------------------------
section('handoffs')

{
  const record = makeHandoff({
    id: 'ho-1', at: 42, from: 'alpha', kind: 'claude', reason: 'rate limit',
    taskHint: 'migrate the schema', tail: 'line1\nline2',
  })
  const prompt = continuationPrompt(record)
  check('continuation names the previous agent', prompt.includes('`alpha`'))
  check('continuation states the reason', prompt.includes('rate limit'))
  check('continuation carries the tail', prompt.includes('line1\nline2'))
  check('continuation carries the task hint', prompt.includes('migrate the schema'))
  check('continuation forbids redoing finished work', /Do not redo/.test(prompt))
  const long = makeHandoff({ id: 'x', at: 0, from: 'a', kind: 'k', reason: 'r', tail: 'z'.repeat(9000) })
  checkEqual('tail is capped at 4000 chars', long.outputTail.length, 4000)
  check('tail keeps the END of the output', long.outputTail.endsWith('z'))
}

// -------------------------------- ledger -------------------------------------
section('ledger revival')

checkEqual('a missing ledger becomes an empty one', reviveLedger(null).handoffs, [])
checkEqual('a partial ledger gains its lists', reviveLedger({ meter: { a: {} } }).handoffs, [])
check('a meter entry without chunks gains an array', Array.isArray(reviveLedger({ meter: { a: {} } }).meter.a.chunks))
checkEqual('unknown versions are still read', reviveLedger({ v: 99, budgets: { a: 1 } }).budgets, { a: 1 })

{
  const { due, stale, pending } = splitParks(
    [
      { name: 'past', fireAtMs: 1000 },      // 99s late — beyond the grace window
      { name: 'due', fireAtMs: 90_000 },     // 10s late — within it
      { name: 'later', fireAtMs: 200_000 },  // not yet
    ],
    100_000,
    30_000,
  )
  checkEqual('a park whose moment has arrived is due', due.map(p => p.name), ['due'])
  checkEqual('a park far past its moment is stale', stale.map(p => p.name), ['past'])
  checkEqual('a future park stays pending', pending.map(p => p.name), ['later'])
}

check('clock helper is available to suites', typeof clock.advance === 'function')
