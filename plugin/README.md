# dsh-herdr-fleet

A DeepSeek Harness **profile bundle** that meters a [Herdr](https://herdr.dev/) agent fleet against
per-agent budgets, halts agents on budget exhaustion and provider rate limits, and captures where
each one left off so another agent can continue the work.

Install and usage live in the [workspace README](../README.md). This file is the package reference:
what the bundle is, what it needs, and the constraints that matter when mounting it.

## What the bundle is

A package whose `package.json` declares `dsh.bundle.patch`. The profile's bundle list selects it,
the patch mounts one row, and the row's `config` is this plugin's configuration. Nothing else is
required — there is no build step and no runtime asset.

| File | Role |
|---|---|
| `index.js` | The Cordis plugin: `name`, `inject`, `Config`, `apply`. Owns the watcher, the ledger, the ten tools, and notice delivery. |
| `core.mjs` | The decision surface as pure functions — metering arithmetic, rate-limit confirmation, snapshot normalization, quoting, handoff prompts. No imports, no I/O, no clock of its own. |
| `cordis.patch.yml` | The bundle patch, with every configuration field documented inline. |

## Requirements

| Requirement | Why | If absent |
|---|---|---|
| `tools` service | Tool registration. Declared in `inject`. | The plugin never activates (Cordis does not run `apply` while a declared injection is missing). |
| `shell` service | Runs the `herdr` CLI. Acquired at runtime through `ctx.inject(['shell', 'timer'], …)`. | The tools still work and report honestly; the watcher does not start. |
| `timer` service | The watcher cadence. Acquired the same way. | Same as above. |
| `herdr` executable | Every observation and every command. | `fleet_status` reports `herdrReachable: false` and the watcher notices once. |
| `agents` service | Resolving the bound brain agent for live notices. Read with an undefined check. | Notices queue for `fleet_status` instead of being delivered live. |

`inject` names **only** `tools`. Cordis has no optional-injection form: listing `shell` or `timer`
there would make the entire plugin silently inactive in any profile that mounts the tool registry
without them — no tools, no error, nothing to debug. Both are therefore acquired as runtime
dependencies, which is why a profile missing them still gets a working tool surface.

## Configuration

Every field is documented in `cordis.patch.yml`. A patch **replaces** the targeted row's whole
`config` rather than merging into it, so a deployment that changes one value must restate the rest.

| Field | Default | Meaning |
|---|---|---|
| `budgetHours` | `5` | Working hours allowed per agent inside the window |
| `windowHours` | `24` | Length of the rolling window the budget is measured over |
| `tickSeconds` | `10` | Watcher cadence; one `herdr api snapshot` per tick |
| `readEveryTicks` | `3` | Read each working agent's output tail every N ticks |
| `readLines` | `60` | Trailing lines read per scan |
| `rlConfirmScans` | `2` | Consecutive throttled scans required before halting |
| `rlCooldownMinutes` | `10` | Per-agent cooldown between rate-limit halts |
| `haltSettleMinutes` | `5` | How long a halt is trusted while Herdr still reports `working` |
| `autoHalt` | `true` | Halt at the ceiling; `false` observes and warns only |
| `notifyOnBlocked` | `true` | Steer the brain when an agent parks on an approval prompt |
| `herdrBin` | `herdr` | Executable name or absolute path |
| `stateDir` | `''` | Ledger directory; empty resolves to `<os home>/.dsh/herdr-fleet` |
| `shellFlavor` | `''` | `pwsh` or `bash` for prompt quoting; empty auto-detects from the host |
| `shellTimeoutMs` | `30000` | Foreground timeout for one Herdr invocation |
| `stdoutMaxBytes` | `2097152` | stdout capture budget per invocation |
| `staleParkGraceMinutes` | `30` | A parked resume older than this is dropped, not fired late |
| `liveNotices` | `true` | Deliver notices to the brain; `false` queues them for `fleet_status` only |

Numeric fields accept any positive value. The plugin does not impose a floor, so `budgetHours: 0.5`
means half an hour.

## Ledger

One JSON file at `<stateDir>/ledger.json`, written atomically (temp file then rename) whenever
something changes, and reloaded on start.

```jsonc
{
  "v": 1,
  "meter":   { "alpha": { "kind": "claude", "chunks": [[1700000020000, 10000]], "lastStatus": "working" } },
  "rl":      { "alpha": { "streak": 2, "lastFiredMs": 1700000020000, "lastHash": "412:…" } },
  "handoffs":[{ "id": "ho-…", "from": "alpha", "reason": "provider rate limit (429 / quota / throttle)", "outputTail": "…" }],
  "notices": [{ "at": 1700000020000, "summary": "alpha rate-limited; handoff ho-…" }],
  "parks":   [{ "name": "alpha", "fireAtMs": 1700000900000, "note": "wait out the 429 window" }],
  "budgets": { "alpha": 7200000 },
  "meta":    { "brainAgentId": "…", "savedAt": 1700000020000 }
}
```

`meter[].chunks` are `[endedAtMillis, workedMillis]` pairs, pruned to the rolling window. Handoffs
are bounded to 10, notices to 20. `meta.brainAgentId` is what lets notices resume reaching the right
agent after a restart; it is re-resolved through the `agents` service on each delivery.

An unrecognised or partial ledger is read leniently — missing lists become empty, and a meter entry
without a `chunks` array gets one — so an older file is never a load failure. The `v` field is
reserved for a future format change; nothing rejects on it today.

## Notices

Delivered with `agent.steer(createUserMessage({ …, source: { kind: 'plugin', plugin: 'herdr-fleet',
form: 'notice', summary } }))`.

`steer` is the one verb that works whatever the brain is doing: it starts a turn when the brain is
idle and reaches a running turn at its next step boundary. `inject` alone would leave an idle brain
asleep beside a notice it never reads.

Live delivery needs a bound brain. The binding is set by the first `fleet_*` tool call and persisted
in the ledger, so a fresh install — where no agent has called a fleet tool yet — queues notices for
`fleet_status` instead. That is the documented behaviour, not a failure.

## Known limitations

- **The `herdr api snapshot` field names are unverified.** Herdr's published docs describe the
  snapshot's semantics, not its schema; the schema is only obtainable from an installed binary via
  `herdr api schema --json`. `normalizeAgents` therefore reads every plausible spelling rather than
  asserting one, and `fleet_probe` reports what the binary actually emits. If agents stop appearing
  in `fleet_status`, `fleet_probe` is the first thing to run.
- **Nothing has been exercised against a live Herdr server** on the machine this was built on. Every
  command is confirmed against Herdr's official CLI reference, and the plugin is confirmed to mount
  and execute under the real Cordis runtime, but the two have not yet been run together.
- **A halt is a terminal interrupt, not a pause.** `Esc` then `Ctrl+C` stops the agent's current
  turn; it does not preserve provider-side conversation state beyond what the CLI itself persists.
  The handoff carries the terminal tail, which is what the next agent gets.
- **Only whole-agent metering is possible.** Herdr reports one status per agent, so an agent driven
  by two models or two accounts is metered as one unit.
- **The watcher polls.** Herdr documents `session.snapshot` as a one-time bootstrap and prefers
  `events.subscribe` for ongoing state. Polling is simpler, bounded, and adequate at a 10-second
  cadence; a subscription would remove the polling cost and is the natural next step.
- **Herdr's own skill forbids this.** Its official skill gates control commands on `HERDR_ENV=1` and
  says not to inspect or control a session from outside Herdr. This plugin drives Herdr from outside
  by design. That is a deliberate decision.
