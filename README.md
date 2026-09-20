# dsh-herdr-fleet

**[github.com/riverho/dsh-herdr-fleet](https://github.com/riverho/dsh-herdr-fleet)** · MIT · v0.1.0

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns a
[Herdr](https://herdr.dev/) pane fleet into something the model can meter, stop, and hand off.

DSH is the brain. Herdr is the nervous system — it owns the panes, the agent processes, and the
lifecycle truth. The agents in those panes are the hands. This plugin is the control plane between
them, and it deliberately refuses to be anything more:

| It does | It never does |
|---|---|
| Meters each agent's **working** time against a budget (5h default) in a rolling window (24h) | Decide what any agent should work on |
| Detects provider throttling and agents parked on approval prompts | Interpret an agent's output as an instruction |
| Halts an agent at its ceiling and captures **where it left off** | Choose the next agent, or whether a handoff is worth making |
| Offers the brain tools + notices to resume that work elsewhere | Retry, re-plan, or silently respawn anything |

Choosing the next task and the next agent stays with the model. That division is the whole point:
Herdr provides a substrate, DSH provides the reasoning, and this plugin supplies the facts each
needs about the other.

---

## Install

The plugin is a **profile bundle**: a package whose `package.json` declares `dsh.bundle.patch`.

### From this repository

Clone the repo and install the `plugin/` directory. That directory *is* the bundle; the rest of the
checkout is its development workspace and is not needed at runtime.

```sh
git clone https://github.com/riverho/dsh-herdr-fleet.git
cd dsh-herdr-fleet
dsh plugin --profile web add "<absolute path to this checkout>/plugin"
```

### From a shell

`dsh plugin` is the only supported install path. It forwards to `pnpm` in the profile directory and
then reconciles `dsh.profile.bundles` against the installed state, so a dependency that declares
`dsh.bundle.patch` — this one does — joins the bundle list on its own. No manual `package.json` edit
is needed.

```sh
dsh plugin --profile web add "C:\Users\RH\dsh-herdr-fleet\plugin"
```

An absolute path is safest: a relative path spec is re-anchored to the directory you invoke `dsh`
from, not to the profile.

### From the model, inside a session

**There is no model-facing `plugin_manager` tool, and no `install_bundle` action.** Nothing in DSH
0.1.5-rc.2 exposes plugin installation to a model: the Cordis tools (`cordis_inspect_list`,
`cordis_inspect_query`) are read-only, and `pluginInventory/list` is explicitly a read-only
display projection. Earlier revisions of this file documented a `plugin_manager
action=install_bundle` call; that tool does not exist in the shipped build, and the install has to
go through the shell command above.

If you want the plugin mounted from your own patch layer instead, that still works:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: herdr-fleet
      name: 'dsh-herdr-fleet'
```

### Verify before you install

The patch composes through the real loader, and the composed row can be inspected without booting
anything:

```sh
dsh --profile web --patch ./plugin/cordis.patch.yml --dump-config | grep -A12 herdr-fleet
```

### Configure

Every field is documented in [`plugin/cordis.patch.yml`](plugin/cordis.patch.yml). A patch replaces
the whole `config` object rather than merging into it, so restate everything you want:

```yaml
- id: herdr-fleet
  config:
    budgetHours: 5
    windowHours: 24
    tickSeconds: 10
    readEveryTicks: 3
    rlConfirmScans: 2
    rlCooldownMinutes: 10
    haltSettleMinutes: 5
    autoHalt: true
    notifyOnBlocked: true
    stateDir: ''
    shellFlavor: ''
    staleParkGraceMinutes: 30
    liveNotices: true
```

---

## What the model gets

Ten tools, all prefixed `fleet_`.

| Tool | Purpose |
|---|---|
| `fleet_status` | The roster, each agent's meter against its budget, pending handoffs, parked resumes, recent notices |
| `fleet_dispatch` | Start an agent in a new Herdr workspace, optionally with its first prompt |
| `fleet_prompt` | Send a prompt; optionally wait for the agent to settle |
| `fleet_read` | Read an agent's recent terminal output |
| `fleet_wait` | Wait for an agent to reach `idle`, `done`, or `blocked` instead of polling |
| `fleet_handoff` | Continue a captured snapshot on another agent — existing or freshly started |
| `fleet_park` | Schedule a resume prompt after N minutes, for waiting out a rate-limit window |
| `fleet_halt` | Interrupt an agent now and capture where it left off |
| `fleet_config` | Read or set per-agent budgets; reset a meter |
| `fleet_probe` | Ask the local Herdr binary for its version and snapshot schema |

### The loop this exists for

1. `fleet_dispatch` starts two agents on the same problem, on different models.
2. One of them hits `429 Too Many Requests`.
3. The watcher confirms the limit across consecutive scans of unchanged output, halts the agent,
   and captures a handoff: why it stopped plus the tail of its terminal.
4. The plugin steers the brain: *"agent `alpha` is stalled on a provider rate limit and was halted.
   Handoff snapshot `ho-…` captures where it left off."*
5. The brain decides. It calls `fleet_handoff handoff_id=ho-… to_kind=codex`, and a fresh agent
   picks up mid-task with the original output in front of it. Or it calls `fleet_park` to wait the
   window out. Or it does neither.

The same machinery enforces the 5-hour budget, with `reason: "5h budget exhausted inside the
rolling 24h window"` on the captured handoff.

---

## How the metering works

Time is credited from **Herdr's own lifecycle authority** — the agent's status in `herdr api
snapshot` — never from wall-clock presence. An agent that sits `blocked` on an approval prompt, or
`idle`, accrues nothing.

Accrual credits the interval between two polls when the agent was `working` at the **previous**
poll, because that is the last moment it was actually observed working. Requiring `working` on both
samples would drop the first interval of every stretch and under-count by one tick each time.

Usage is stored as `[endedAt, milliseconds]` chunks in a rolling window, so old usage expires
continuously rather than resetting at a boundary. The ledger is written atomically (temp file plus
rename) and reloaded on start, so budgets survive a restart.

Two independent guards stop a halt from repeating: a halted agent is skipped until Herdr reports it
out of `working`, and a settle window (`haltSettleMinutes`) covers an interrupt that was slow or
ignored. Without both, a single exhaustion would send Esc every tick and capture an identical
handoff each time.

### Rate limits are confirmed, not guessed

A rate limit must appear on `rlConfirmScans` (default 2) **consecutive scans of unchanged output**.
Unchanged output is itself the evidence that the agent is stuck rather than merely mentioning
throttling while it works. `rlCooldownMinutes` bounds how often one agent can trigger a halt.

The patterns cover `429`, `rate limit`, `too many requests`, `quota exceeded`, `usage limit`, `retry
after`, `try again in`, `throttled`, `overloaded`, `529`, `capacity reached`, and `limit resets at`,
and are suppressed by a negation filter so "rate limiting is disabled" does not trip them. A false
positive costs a halt the brain can undo with `fleet_prompt`; a false negative costs a wasted
agent-hour.

---

## What was verified, and what was not

Herdr is not installed on the machine this was built on, so **nothing here has been run against a
live Herdr server**. Be explicit about which claims rest on what.

**Verified against official Herdr documentation** ([CLI reference](https://herdr.dev/docs/preview/cli-reference/),
[socket API](https://herdr.dev/docs/preview/socket-api/)) — every command this plugin issues:

`herdr api snapshot`, `herdr api schema --json`, `herdr workspace create --cwd … --label … --no-focus`,
`herdr agent start <name> --kind <kind> --pane <id>`, `herdr agent prompt <target> <text> [--wait
--timeout ms]`, `herdr agent read <target> --source recent-unwrapped --lines N`, `herdr agent
send-keys <target> esc|ctrl+c`, `herdr agent wait <target> --until <status> --timeout ms`.

Also confirmed: `agent read` prints **raw terminal text, not JSON** (the plugin branches on that);
the 24 agent kinds in `core.mjs` are exactly Herdr's `--kind` enum; and agent names must match
`[a-z][a-z0-9_-]{0,31}`.

**Verified against the DSH 0.1.5-rc.2 runtime, end to end.** The whole install chain was exercised
against a real `dsh` process, in a throwaway profile composed from the shipped `base` + `headless`
bundles:

1. `dsh-herdr-fleet` placed on the profile's `dsh.profile.bundles` list,
2. the loader read the package's `dsh.bundle.patch` and applied its insert row — `dsh --profile …
   --dump-config` printed the row and its complete config, exit 0,
3. a full `dsh --profile … "<task>"` boot ran the task and exited 0,
4. the model, given a real prompt, discovered and called `fleet_status`, and the tool executed and
   answered correctly (`herdr reachable: false`, `0` agents — Herdr is not installed here),
5. the plugin wrote a valid ledger to `~/.dsh/herdr-fleet/ledger.json` with the owning session bound.

`test/integration.test.mjs` covers the same ground in-process against a real Cordis `Context` with
the real `ToolRuntime`, so the result is regression-tested rather than a one-off observation.

**Not verified:** the exact JSON field names inside `herdr api snapshot`. Herdr's docs describe the
snapshot's *semantics* but not its schema, and the schema is only obtainable from an installed
binary. So `normalizeAgents` reads every plausible spelling (`agents[]` / `panes[]` / `agent_records[]`;
`name`/`agent_name`; `agent`/`kind`; `status`/`agent_status`; `pane_id`/`paneId`/`id`) rather than
asserting one, and `fleet_probe` exists to resolve it against a real server:

```
fleet_probe        # → version, schemaAvailable, detectedAgentRecordKeys, agentsVisibleNow
```

If agents do not appear in `fleet_status`, run `fleet_probe` first: it reports what the binary
actually emits.

---

## Why this is a bundle and not a dynamic Cordis package

The first attempt at this plugin was written as the host half of a **dynamic Cordis package** — a
`node:vm` sandbox body evaluated at runtime. That approach cannot be shipped, and the reason is
worth recording.

DSH deliberately provides no way to create a dynamic definition from outside the process:

- The model-facing Cordis tools are `cordis_inspect_list` and `cordis_inspect_query`, both
  **read-only**. `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` were retired, and
  the e2e suites assert their absence.
- `ctx.dynamicCordisRunner.define` / `run` / `stop` / `undefine` carry no `@Remote` decorator, so
  none of them is reachable over JSON-RPC, HTTP, or the browser panel. The panel can only stop,
  remove, and list definitions that already exist.
- Nothing in `cordis.yml` or a profile patch can inject a definition; the runner's only config field
  is `vmTimeoutMs`.
- Definitions are session-scoped and process-local, and are cleared on restart.

So a dynamic package is reachable only from in-process TypeScript — and anyone writing that code
could write the plugin directly instead. A **persistent bundle** is the supported, installable,
restart-surviving form, and it is what `plugin/` contains.

The sandbox variant was also broken in ways that would only have failed at runtime: its helpers
referred to a bare `shell` and `fs` that exist nowhere in the sandbox (the façade exposes
`ctx.shell` and `ctx.fs`), and its PowerShell prompt-quoting expression opened a parenthesis it never
closed. It has been removed rather than left as a second, non-installable implementation. The
metering, detection, and handoff logic it contained lives on in [`plugin/core.mjs`](plugin/core.mjs),
now shared and tested.

One further note on Herdr's own safety stance: Herdr's official skill gates every control command on
`HERDR_ENV=1` and says not to drive a session from outside Herdr. This plugin drives Herdr from
outside by design — that is what makes it a fleet control plane rather than a wrapper. It is a
deliberate decision, not an accident, and worth knowing if you also use Herdr's own skill.

---

## Development

From a clean checkout, no install step and nothing downloaded:

```sh
git clone https://github.com/riverho/dsh-herdr-fleet.git
cd dsh-herdr-fleet
node scripts/link-deps.mjs     # link the dsh-provided packages into ./node_modules
node test/run.mjs              # 185 checks
```

`npm run setup` and `npm test` are the same two commands. A `dsh` installation must already exist
on the machine: `link-deps.mjs` points `./node_modules/@deepseek-ai/*` at the packages your dsh
installation already has, so the tests run against exactly the framework versions dsh itself loads,
with nothing downloaded.

| Suite | Covers |
|---|---|
| `test/core.test.mjs` | Pure logic: metering arithmetic, window pruning, rate-limit confirmation, snapshot normalization, name derivation, shell quoting, handoff prompts |
| `test/plugin.test.mjs` | The plugin wired to a fake context and a scriptable `herdr` CLI: budget exhaustion, rate-limit halts, handoff dispatch, parks, blocked agents, restart persistence, an unreachable Herdr, result hygiene |
| `test/integration.test.mjs` | The manifest contract, and the plugin mounted under a real Cordis `Context` with the real `ToolRuntime` |

`test/harness.mjs` holds the fakes. It deliberately does **not** transition an agent's status when
`send-keys` arrives: real Herdr takes a moment to reflect an interrupt, and a double that flips
instantly would hide the re-halt guard entirely.

## Layout

```
plugin/                 the installable bundle
  package.json          manifest; declares dsh.bundle.patch
  cordis.patch.yml      the profile patch that mounts it (every setting documented)
  index.js              the Cordis plugin: config, watcher, tools, notices
  core.mjs              pure decision surface — no imports, no I/O, no clock of its own
test/                   the suite
scripts/link-deps.mjs   makes the suite runnable from a clean checkout
```

`node_modules/` is generated by `link-deps.mjs`, and `_ref/` is a local-only checkout of the
DeepSeek Harness source used while developing against the real loader; both are gitignored.

## License

[MIT](LICENSE).
