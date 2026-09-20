// Test entry point: runs every suite in one process and exits non-zero on
// failure.  Usage:  node test/run.mjs
import { summary } from './harness.mjs'

await import('./core.test.mjs')
await import('./plugin.test.mjs')
await import('./integration.test.mjs')

process.exit(summary())
