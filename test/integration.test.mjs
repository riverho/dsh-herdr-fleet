// ============================================================================
//  integration.test.mjs — load the plugin through the REAL Cordis runtime.
//
//  The unit suite drives `apply()` with a hand-built context. This one boots an
//  actual `@deepseek-ai/cordis` Context, mounts the real `ToolRuntime` and the
//  real timer plugin, and provides a fake `shell` service — so the plugin's
//  `name`/`inject`/`Config`/`apply` form, its inject gate, and its tool
//  registration are all exercised by the framework rather than by a stand-in.
// ============================================================================

import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import timer from '@deepseek-ai/cordis-plugin-timer'
import { check, checkEqual, section } from './harness.mjs'
import { readFileSync } from 'node:fs'

section('real cordis integration')

/** A `ctx.shell` stand-in: records commands and answers one canned snapshot. */
function fakeShell() {
  return {
    commands: [],
    resolve(request) {
      return {
        command: request.command,
        workdir: process.cwd(),
        timeoutMs: request.timeoutMs ?? 30_000,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 2 * 1024 * 1024,
      }
    },
    async run(spec) {
      this.commands.push(spec.command)
      const snapshot = JSON.stringify({
        result: { agents: [{ name: 'alpha', agent: 'claude', pane_id: 'p1', status: 'working', workspace_id: 'w1' }] },
      })
      return {
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: spec.command.includes('api snapshot') ? snapshot : '', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
  }
}

// A `private: true` package with a `dsh.bundle.patch` is what the plugin manager
// accepts as an installable bundle; a manifest without it is refused outright.
{
  const manifest = JSON.parse(readFileSync(new URL('../plugin/package.json', import.meta.url), 'utf8'))
  check('manifest declares a bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(manifest.dsh))
  check('manifest exposes the patch file', manifest.exports['./cordis.patch.yml'] === './cordis.patch.yml')
  check('manifest ships every runtime file', ['index.js', 'core.mjs', 'cordis.patch.yml', 'README.md'].every(file => manifest.files.includes(file)), JSON.stringify(manifest.files))
  check('the patch file exists at the declared path', (() => {
    try { readFileSync(new URL('../plugin/cordis.patch.yml', import.meta.url), 'utf8'); return true } catch { return false }
  })())
  check('the patch inserts this package by its own name', (() => {
    const patch = readFileSync(new URL('../plugin/cordis.patch.yml', import.meta.url), 'utf8')
    return patch.includes('name: \'dsh-herdr-fleet\'') && patch.includes('- insert:')
  })())
}

// -------------------------- the plugin mounts for real -----------------------
{
  const ctx = new Context()
  const shell = fakeShell()
  // ToolRuntime declares `systemPrompt` in its own inject list, so it only
  // activates once that registry exists — mount it first.
  const fibers = []
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(timer))
  ctx.provide('shell', shell)

  const plugin = await import(`../plugin/index.js?v=${Math.random()}`)
  checkEqual('exports the cordis function-plugin form', typeof plugin.apply, 'function')
  checkEqual('declares its name', plugin.name, 'herdr-fleet')
  checkEqual('requires only the tools registry', plugin.inject, ['tools'])
  check('declares a config schema', plugin.Config !== undefined)

  const fleetFiber = await ctx.plugin(plugin, { stateDir: '', tickSeconds: 3600 })
  // Cordis runs `apply` when its declared injections resolve. `tools` exists,
  // so the plugin must have activated and registered its surface.
  const schemas = ctx.tools.schemas()
  const names = schemas.map(schema => schema.name).sort()
  checkEqual('the real runtime sees the whole tool surface', names, [
    'fleet_config', 'fleet_dispatch', 'fleet_halt', 'fleet_handoff', 'fleet_park',
    'fleet_probe', 'fleet_prompt', 'fleet_read', 'fleet_status', 'fleet_wait',
  ])
  check('fleet_status exposes a model-facing description', (ctx.tools.get('fleet_status')?.description ?? '').length > 40)

  // A real dispatch through the real registry, with model-shaped arguments.
  const result = await ctx.tools.execute({
    callId: 'call-1',
    name: 'fleet_status',
    arguments: {},
    signal: new AbortController().signal,
  })
  check('fleet_status executes through ToolRuntime', result.isError !== true, JSON.stringify(result).slice(0, 300))
  const text = (result.content ?? []).map(block => block.text ?? '').join('\n')
  check('the rendered result reports the fleet', text.includes('alpha'), text.slice(0, 300))
  check('the watcher polled herdr', shell.commands.some(command => command.includes('api snapshot')), shell.commands.join(' | '))

  // Disposing the plugin's fiber must take its watcher interval with it; an
  // interval that outlived the plugin would keep the process alive and keep
  // polling a server nobody is listening to.
  await fleetFiber.dispose()
  const before = shell.commands.length
  await new Promise(resolve => setTimeout(resolve, 50))
  checkEqual('disposal stops the watcher', shell.commands.length, before)

  for (const fiber of fibers) await fiber.dispose()
}

export {}
