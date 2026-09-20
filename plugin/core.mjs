// ============================================================================
//  core.mjs — the whole herdr-fleet decision surface, as pure functions.
// ----------------------------------------------------------------------------
//  No imports, no ctx, no I/O, no clock of its own: every entry point takes the
//  time it should use and the state it should read, and returns data. That is
//  what lets ONE implementation back both shipped shapes:
//
//    * index.js        — the native Cordis plugin (a persistent dsh bundle).
//    * host-source.js  — the dynamic-package host half, whose node:vm sandbox
//                        has no `import` at all. Generated from this file by
//                        scripts/build-host-source.mjs, so the two cannot drift.
//
//  Keeping it dependency-free is a hard requirement of that second shape, not a
//  style preference: the sandbox exposes no module loader.
// ============================================================================

/**
 * Agent kinds Herdr accepts for `agent start --kind`. Verified against the
 * official CLI reference (24 kinds); order is irrelevant to Herdr.
 */
export const KINDS = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
  'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok',
  'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse',
]

/**
 * Provider throttling as it appears in a coding agent's terminal output.
 * Broad on purpose: one missed limit costs a wasted agent-hour, one false
 * positive costs a halt the brain can immediately undo with `fleet_prompt`.
 * `429` is bounded by word boundaries so a byte count or an id cannot trip it.
 */
export const RATE_LIMIT_RE = new RegExp([
  'rate[ _-]?limit', 'ratelimited', 'too many requests', '\\b429\\b',
  'quota (exceeded|reached|exhausted)', 'usage limit', 'weekly limit',
  'retry[ _-]?after', 'try again in', 'throttl', 'overloaded',
  '\\b529\\b', 'capacity (reached|exceeded)', 'exceeded your current quota',
  'limit (will )?reset', 'resets? at',
].join('|'), 'i')

/** Lines that mention throttling only to deny it — suppresses the obvious false positives. */
const RATE_LIMIT_NEGATIVE_RE = /(no|not|without|avoid|disable[d]?)\s+(a\s+)?rate[ _-]?limit|rate[ _-]?limit(ing)?\s*(is\s*)?(ok|fine|none|disabled)/i

/** Herdr agent lifecycle states. `done` is idle-but-unseen; `blocked` is a recognised approval UI. */
export const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown']

// ------------------------------ scalar helpers ------------------------------

/** @returns {number} wall-clock milliseconds. */
export function nowMs() { return Date.now() }

/** @param {number} n @returns {number} n rounded to 2 decimals (for hour displays). */
export function round2(n) { return Math.round(n * 100) / 100 }

/** @param {number} ms @returns {number} ms as hours, rounded to 2 decimals. */
export function hours(ms) { return round2(ms / 3600000) }

/** @param {number} n @param {number} lo @param {number} hi @returns {number} n clamped to [lo, hi]. */
export function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi) }

/**
 * Keep the LAST `max` characters. Terminal tails are the useful end of an
 * agent's output: the error, the prompt, the rate-limit notice.
 * @param {unknown} text @param {number} max @returns {string}
 */
export function truncate(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : text.slice(text.length - max)
}

/**
 * Keep the FIRST `max` characters.
 * @param {unknown} text @param {number} max @returns {string}
 */
export function truncateHead(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Parse JSON without throwing. Herdr prints JSON for most verbs but raw
 * terminal text for `agent read`, so callers must branch on this result.
 * @param {unknown} text @returns {{ok: true, value: unknown} | {ok: false}}
 */
export function safeJson(text) {
  if (typeof text !== 'string') return { ok: false }
  try { return { ok: true, value: JSON.parse(text) } } catch { return { ok: false } }
}

/** @param {unknown} name @returns {boolean} whether Herdr will accept this agent name. */
export function isAgentName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(name)
}

/**
 * Derive a valid, unique Herdr agent name from an arbitrary label.
 * Herdr requires `[a-z][a-z0-9_-]{0,31}` and uniqueness among live agents.
 * @param {unknown} label @param {Iterable<string>} [taken] @returns {string}
 */
export function deriveAgentName(label, taken = []) {
  const base = String(label ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const seeded = /^[a-z]/.test(base) ? base : `a-${base}`
  const stem = (seeded || 'agent').slice(0, 32)
  const used = new Set(taken)
  if (!used.has(stem)) return stem
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const candidate = `${stem.slice(0, 32 - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return stem
}

// ------------------------------ shell quoting --------------------------------
// Prompts are arbitrary multi-line text and must reach herdr as exactly ONE
// argv element. Rather than escape for two different shells, the text is
// base64-encoded into an expression the shell evaluates to the original string.

/**
 * Build a shell expression that evaluates to `text`, for the given shell flavor.
 *
 * base64 is used because the two supported flavors have incompatible escaping
 * rules and a prompt can contain quotes, newlines, `$`, and backticks. The
 * expression is a single argument once the shell expands it.
 *
 * @param {unknown} text @param {'pwsh' | 'bash'} [flavor] @returns {string}
 */
export function shellTextArg(text, flavor = 'pwsh') {
  const encoded = base64Encode(String(text ?? ''))
  if (flavor === 'bash') return `"$(printf %s '${encoded}' | base64 -d)"`
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`
}

/**
 * Quote one literal argument for the given shell flavor.
 * @param {unknown} value @param {'pwsh' | 'bash'} [flavor] @returns {string}
 */
export function quoteArg(value, flavor = 'pwsh') {
  const text = String(value ?? '')
  if (flavor === 'bash') return `'${text.replace(/'/g, `'\\''`)}'`
  return `'${text.replace(/'/g, "''")}'`
}

/** @param {string} text @returns {string} base64 of the UTF-8 bytes. */
export function base64Encode(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// --------------------------- snapshot normalization --------------------------
// Herdr's `session.snapshot` JSON field names are not published in the docs --
// they are only obtainable from a running binary via `herdr api schema --json`.
// So this reads every plausible spelling rather than asserting one, and the
// plugin ships `fleet_probe` for an operator to confirm the real shape once.

const NAME_KEYS = ['name', 'agent_name', 'agentName']
const KIND_KEYS = ['agent', 'kind', 'agent_kind', 'agentKind']
const STATUS_KEYS = ['status', 'agent_status', 'agentStatus']
const PANE_KEYS = ['pane_id', 'paneId', 'id']
const WS_KEYS = ['workspace_id', 'workspaceId']

/** @returns {unknown} the first present, non-empty value among `keys`. */
function pick(record, keys) {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** @returns {unknown[]} the arrays a snapshot may carry agents or panes in. */
function recordLists(snapshot) {
  const root = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const result = root.result && typeof root.result === 'object' ? root.result : root
  const lists = []
  for (const container of [result, root]) {
    for (const key of ['agents', 'agent_records', 'panes', 'pane_records']) {
      const value = container[key]
      if (Array.isArray(value)) lists.push({ key, value })
    }
  }
  return lists
}

/**
 * Flatten a `herdr api snapshot` response into a stable agent roster.
 *
 * Reads every plausible field spelling because the published docs describe the
 * snapshot's *semantics* but not its field names. Records that carry neither a
 * name nor a pane id are dropped; a pane record counts as an agent only when it
 * reports an agent kind or an agent status, so plain shell panes stay out.
 *
 * @param {unknown} snapshot - parsed `herdr api snapshot` output, or its `result`.
 * @returns {{name: string, kind: string, paneId: string, status: string, workspaceId: string, source: string}[]}
 */
export function normalizeAgents(snapshot) {
  const agents = []
  const seen = new Set()
  for (const { key, value } of recordLists(snapshot)) {
    const fromAgents = key === 'agents' || key === 'agent_records'
    for (const record of value) {
      if (!record || typeof record !== 'object') continue
      const paneId = String(pick(record, PANE_KEYS) ?? '')
      const name = String(pick(record, NAME_KEYS) ?? (fromAgents ? '' : paneId))
      if (!name) continue
      const kind = pick(record, KIND_KEYS)
      const status = pick(record, STATUS_KEYS)
      // A pane row without any agent signal is a shell, not an agent.
      if (!fromAgents && kind === undefined && status === undefined) continue
      if (seen.has(name)) continue
      seen.add(name)
      agents.push({
        name,
        kind: kind === undefined ? 'unknown' : String(kind),
        paneId,
        status: status === undefined ? 'unknown' : String(status),
        workspaceId: String(pick(record, WS_KEYS) ?? ''),
        source: fromAgents ? 'agents' : 'panes',
      })
    }
  }
  return agents
}

// --------------------------------- metering ----------------------------------
// Wall-clock "working" time, accrued from Herdr's own lifecycle authority.

/** @returns {object} a fresh ledger with the current schema version. */
export function defaultLedger() {
  return { v: 1, meter: {}, rl: {}, handoffs: [], notices: [], parks: [], budgets: {}, meta: {} }
}

/**
 * Read (creating on demand) one agent's meter entry.
 * @param {Record<string, object>} meter @param {string} name @param {string} [kind]
 * @returns {{kind: string, chunks: [number, number][], lastSeenMs: number, lastStatus: string}}
 */
export function meterEntry(meter, name, kind) {
  let entry = meter[name]
  if (!entry) {
    entry = { kind: kind || 'unknown', chunks: [], lastSeenMs: 0, lastStatus: 'unknown' }
    meter[name] = entry
  }
  if (!Array.isArray(entry.chunks)) entry.chunks = []
  if (kind && (!entry.kind || entry.kind === 'unknown')) entry.kind = kind
  return entry
}

/**
 * Drop accrual chunks older than the rolling window. Chunks are `[endedAtMs, ms]`
 * and are appended in time order, so one prefix walk is enough.
 * @param {{chunks: [number, number][]}} entry @param {number} now @param {number} windowMs
 * @returns {void}
 */
export function pruneChunks(entry, now, windowMs) {
  const cutoff = now - windowMs
  while (entry.chunks.length > 0 && entry.chunks[0][0] < cutoff) entry.chunks.shift()
}

/**
 * Working milliseconds inside the rolling window.
 * @param {{chunks: [number, number][]}} entry @param {number} now @param {number} windowMs
 * @returns {number}
 */
export function usedMs(entry, now, windowMs) {
  if (!entry || !Array.isArray(entry.chunks)) return 0
  pruneChunks(entry, now, windowMs)
  let total = 0
  for (const chunk of entry.chunks) total += chunk[1]
  return total
}

/**
 * Accrue one tick of working time.
 *
 * The interval between two polls is credited when the agent was `working` at the
 * PREVIOUS poll: that is the last moment we actually observed it working. A
 * `working -> working` sample would drop the first interval of every stretch and
 * under-count by one tick each time.
 *
 * @param {object} entry - the meter entry, mutated in place.
 * @param {string} status - status observed now.
 * @param {number} now - current time.
 * @param {number} elapsedMs - milliseconds since the previous poll.
 * @returns {boolean} whether the meter changed and needs persisting.
 */
export function accrueWorking(entry, status, now, elapsedMs) {
  const wasWorking = entry.lastStatus === 'working'
  entry.lastStatus = status
  entry.lastSeenMs = now
  if (!wasWorking || elapsedMs <= 0) return false
  entry.chunks.push([now, elapsedMs])
  return true
}

/**
 * Resolve an agent's budget in milliseconds, honouring a per-agent override.
 * @param {Record<string, number>} budgets @param {string} name @param {number} defaultMs
 * @returns {number}
 */
export function budgetFor(budgets, name, defaultMs) {
  const custom = budgets ? budgets[name] : undefined
  return typeof custom === 'number' && custom > 0 ? custom : defaultMs
}

// ---------------------------- rate-limit confirmation ------------------------

/**
 * Score one output tail against the throttling patterns.
 * @param {unknown} text @returns {boolean}
 */
export function matchRateLimit(text) {
  if (typeof text !== 'string' || text === '') return false
  if (!RATE_LIMIT_RE.test(text)) return false
  return !RATE_LIMIT_NEGATIVE_RE.test(text)
}

/**
 * Advance the confirm/cooldown state machine for one agent.
 *
 * A single scan is too noisy to halt an agent on, so a limit must be seen on
 * `confirmScans` consecutive scans *of unchanged output* -- unchanged output is
 * itself the evidence that the agent is stuck rather than merely mentioning
 * throttling while it works.
 *
 * @param {object} rl - per-agent `{streak, lastFiredMs, lastHash}` state.
 * @param {unknown} tail - the agent's current output tail.
 * @param {{confirmScans: number, cooldownMs: number}} cfg
 * @param {number} now
 * @returns {{hit: boolean, streak: number, reason?: string}}
 */
export function rateLimitStep(rl, tail, cfg, now) {
  if (!matchRateLimit(tail)) {
    rl.streak = 0
    rl.lastHash = ''
    return { hit: false, streak: 0 }
  }
  const hash = `${String(tail).length}:${truncate(tail, 160)}`
  rl.streak = rl.lastHash === hash ? (rl.streak || 0) + 1 : 1
  rl.lastHash = hash
  if (rl.streak < cfg.confirmScans) return { hit: false, streak: rl.streak }
  // `lastFiredMs === 0` means "never fired": without this guard a clock reading
  // below the cooldown would suppress the FIRST halt, and a system clock that
  // stepped backwards would suppress every halt until it caught up.
  if (rl.lastFiredMs && now - rl.lastFiredMs <= cfg.cooldownMs) {
    return { hit: false, streak: rl.streak, reason: 'cooldown' }
  }
  rl.lastFiredMs = now
  return { hit: true, streak: rl.streak }
}

// -------------------------------- handoffs -----------------------------------

/**
 * Build the handoff record captured at a halt. This is "where it left off":
 * the reason, the agent identity, and the tail of what it had produced.
 * @param {{from: string, kind: string, paneId?: string, workspaceId?: string, reason: string,
 *          taskHint?: string, tail?: string, at: number, id: string}} input
 * @returns {object}
 */
export function makeHandoff(input) {
  return {
    id: input.id,
    at: input.at,
    from: input.from,
    kind: input.kind || 'unknown',
    paneId: input.paneId || '',
    workspaceId: input.workspaceId || '',
    reason: input.reason,
    taskHint: truncateHead(input.taskHint || '', 500),
    outputTail: truncate(input.tail || '', 4000),
  }
}

/**
 * Render the prompt that resumes a halted agent's work on a different agent.
 * @param {object} record - a {@link makeHandoff} record.
 * @returns {string}
 */
export function continuationPrompt(record) {
  const lines = [
    `You are continuing work another agent had to abandon mid-task.`,
    ``,
    `Previous agent: \`${record.from}\` (kind: \`${record.kind}\`)`,
    `Why it stopped: ${record.reason}`,
  ]
  if (record.taskHint) lines.push(`Original task: ${record.taskHint}`)
  lines.push(
    ``,
    `Where it left off — the tail of its terminal output:`,
    '```',
    record.outputTail || '(no output captured)',
    '```',
    ``,
    `Continue from exactly that point. Do not redo work that already looks complete.`,
    `Begin by stating in one or two lines what remains to be done, then do it.`,
  )
  return lines.join('\n')
}

/**
 * Append a record to a bounded list, dropping the oldest beyond `max`.
 * @template T @param {T[]} list @param {T} item @param {number} max @returns {T[]} the same array.
 */
export function pushBounded(list, item, max) {
  list.push(item)
  while (list.length > max) list.shift()
  return list
}

// -------------------------------- reporting ----------------------------------

/**
 * Build the whole `fleet_status` view: live agents joined with their meters,
 * plus the brain's pending work.
 * @param {{agents: object[], meter: Record<string, object>, budgets: Record<string, number>,
 *          defaultBudgetMs: number, windowMs: number, now: number, handoffs: object[],
 *          notices: object[], parks: object[], reachable: boolean, lastError?: string}} input
 * @returns {object}
 */
export function statusView(input) {
  const { agents, meter, budgets, defaultBudgetMs, windowMs, now } = input
  const rows = []
  const seen = new Set()

  for (const agent of agents) {
    seen.add(agent.name)
    rows.push(meterRow(agent.name, agent.kind, agent.status, input))
  }
  // Agents we have metered but that Herdr is not reporting right now (halted,
  // crashed, or removed) stay visible: their budget is still spent.
  for (const name of Object.keys(meter)) {
    if (seen.has(name)) continue
    rows.push(meterRow(name, meter[name].kind || 'unknown', 'unseen', input))
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))

  const { handoffs, notices, parks } = input
  return {
    herdrReachable: input.reachable,
    herdrError: input.lastError,
    budgets: { defaultHours: hours(defaultBudgetMs), windowHours: hours(windowMs), overrides: budgets || {} },
    agents: rows,
    pendingHandoffs: handoffs.map(record => ({
      id: record.id,
      from: record.from,
      kind: record.kind,
      reason: record.reason,
      at: record.at,
    })),
    parked: parks.map(park => ({ name: park.name, inMinutes: round2((park.fireAtMs - now) / 60000), note: park.note })),
    recentNotices: notices.slice(-8),
  }
}

/** @returns {object} one agent's status row. */
function meterRow(name, kind, status, input) {
  const entry = input.meter[name]
  const used = entry ? usedMs(entry, input.now, input.windowMs) : 0
  const budget = budgetFor(input.budgets, name, input.defaultBudgetMs)
  return {
    name,
    kind: kind || 'unknown',
    status,
    usedHours: hours(used),
    budgetHours: hours(budget),
    remainingHours: hours(Math.max(budget - used, 0)),
    exhausted: used >= budget,
  }
}

/**
 * Model-facing text for {@link statusView}.
 * @param {object} view @returns {string}
 */
export function renderStatus(view) {
  const lines = [`herdr reachable: ${view.herdrReachable}${view.herdrError ? ` (${view.herdrError})` : ''}`]
  if (view.agents.length === 0) {
    lines.push('no agents are running.')
  } else {
    lines.push(`agents — ${view.budgets.defaultHours}h budget per rolling ${view.budgets.windowHours}h:`)
    for (const row of view.agents) {
      const flag = row.exhausted ? '  ** EXHAUSTED **' : ''
      lines.push(`  - ${row.name} [${row.kind}] ${row.status} — ${row.usedHours}h used, ${row.remainingHours}h left of ${row.budgetHours}h${flag}`)
    }
  }
  if (view.pendingHandoffs.length > 0) {
    lines.push('pending handoffs (call fleet_handoff to continue one):')
    for (const handoff of view.pendingHandoffs) {
      lines.push(`  - ${handoff.id}: ${handoff.from} [${handoff.kind}] — ${handoff.reason}`)
    }
  }
  if (view.parked.length > 0) {
    lines.push('parked for a later resume:')
    for (const park of view.parked) lines.push(`  - ${park.name} resumes in ${park.inMinutes}m — ${park.note}`)
  }
  if (view.recentNotices.length > 0) {
    lines.push('recent notices:')
    for (const notice of view.recentNotices) lines.push(`  - ${notice.summary}`)
  }
  return lines.join('\n')
}

// ------------------------------- ledger state --------------------------------

/**
 * Copy persisted lists onto a runtime ledger, tolerating an older or partial file.
 * @param {object} raw - the parsed ledger file.
 * @returns {object} a ledger whose lists are always arrays.
 */
export function reviveLedger(raw) {
  const base = defaultLedger()
  if (!raw || typeof raw !== 'object') return base
  const ledger = {
    v: 1,
    meter: raw.meter && typeof raw.meter === 'object' ? raw.meter : {},
    rl: raw.rl && typeof raw.rl === 'object' ? raw.rl : {},
    handoffs: Array.isArray(raw.handoffs) ? raw.handoffs : [],
    notices: Array.isArray(raw.notices) ? raw.notices : [],
    parks: Array.isArray(raw.parks) ? raw.parks : [],
    budgets: raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : {},
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
  }
  for (const entry of Object.values(ledger.meter)) {
    if (entry && !Array.isArray(entry.chunks)) entry.chunks = []
  }
  return ledger
}

/**
 * Sort parked resumes by whether their moment has arrived.
 *
 * A park is DUE once `now` reaches `fireAtMs`, and STALE when it is more than
 * `graceMs` late — the case where dsh was not running when it should have
 * fired. Firing a stale park would push a resume prompt on top of whatever the
 * agent has since been told to do, so the caller drops it and says so.
 *
 * @param {object[]} parks @param {number} now @param {number} graceMs
 * @returns {{due: object[], stale: object[], pending: object[]}}
 */
export function splitParks(parks, now, graceMs) {
  const due = []
  const stale = []
  const pending = []
  for (const park of parks) {
    if (park.fireAtMs > now) pending.push(park)
    else if (now - park.fireAtMs > graceMs) stale.push(park)
    else due.push(park)
  }
  return { due, stale, pending }
}

/** @returns {string} a short unique-ish id with the given prefix. */
export function makeId(prefix, at) {
  return `${prefix}-${at}-${Math.floor(Math.random() * 1e6).toString(36)}`
}
