// ============================================================================
//  link-deps.mjs — make the tests runnable from a clean checkout.
//
//  plugin/index.js imports the same packages dsh itself provides at runtime
//  (@deepseek-ai/cordis, dsh-tools, dsh-llm, schemastery). The tests load the
//  real ones rather than stubs, so they must be resolvable from this directory.
//
//  A dsh installation already has them: every profile shares one hoisted
//  node_modules. This script links the handful we need out of the dsh home into
//  ./node_modules, so nothing is downloaded and the versions are exactly the
//  ones the installed dsh runs against.
//
//  Usage:  node scripts/link-deps.mjs [--check]
// ============================================================================

import { existsSync, mkdirSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCOPE = '@deepseek-ai'

/** Packages plugin/index.js and the integration test resolve at import time. */
const REQUIRED = ['cordis', 'schemastery', 'dsh-tools', 'dsh-llm', 'dsh-system-prompt', 'cordis-plugin-timer']

/** Where an installed dsh keeps the packages every profile shares. */
function candidateSources() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', SCOPE),
    join(dshHome, 'profiles', 'web', 'node_modules', SCOPE),
    join(dshHome, 'profiles', 'headless', 'node_modules', SCOPE),
  ]
  return candidates.filter(candidate => existsSync(candidate))
}

/** @returns {string | null} a shared scope directory holding every required package. */
function findSource() {
  for (const candidate of candidateSources()) {
    const available = new Set(readdirSync(candidate))
    if (REQUIRED.every(name => available.has(name))) return candidate
  }
  return null
}

const checkOnly = process.argv.includes('--check')
const source = findSource()

if (!source) {
  console.error(
    'link-deps: no dsh installation found with the required packages.\n'
    + `  looked for ${REQUIRED.join(', ')} under ${candidateSources().join(' and ') || '(no candidate directories)'}\n`
    + '  set DSH_HOME to the directory holding your profiles, or install dsh once so it can populate them.',
  )
  process.exit(1)
}

console.log(`link-deps: linking from ${source}`)

const target = join(ROOT, 'node_modules', SCOPE)
mkdirSync(target, { recursive: true })

let linked = 0
let present = 0
for (const name of REQUIRED) {
  const destination = join(target, name)
  // A Windows junction needs no elevation; elsewhere a directory symlink does.
  const type = process.platform === 'win32' ? 'junction' : 'dir'

  if (existsSync(destination)) {
    present += 1
    continue
  }
  if (checkOnly) {
    console.error(`link-deps: missing ${destination}`)
    process.exit(1)
  }
  try {
    symlinkSync(join(source, name), destination, type)
    linked += 1
  } catch (error) {
    // A stale link (target moved) reports EEXIST on some platforms: replace it.
    if (error?.code === 'EEXIST') {
      rmSync(destination, { recursive: true, force: true })
      symlinkSync(join(source, name), destination, type)
      linked += 1
      continue
    }
    console.error(`link-deps: could not link ${name}: ${error?.message ?? error}`)
    process.exit(1)
  }
}

console.log(`link-deps: ${linked} linked, ${present} already present`)
console.log('link-deps: run the suite with `node test/run.mjs`')
