#!/usr/bin/env node
import { resolve } from 'node:path'
import { verifyBundleProvenance } from './bundle-provenance.mjs'

const args = process.argv.slice(2)
if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--installed')) {
  throw new Error('usage: verify-bundle-provenance.mjs <bundle-root> [--installed]')
}
const result = verifyBundleProvenance(resolve(args[0]), { installed: args[1] === '--installed' })
process.stdout.write(`${JSON.stringify(result)}\n`)
if (!result.ok) process.exitCode = 1
