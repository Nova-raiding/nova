#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { realpathSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index]
  const value = process.argv[index + 1]
  if (!flag?.startsWith('--') || !value) throw new Error(`invalid argument: ${flag ?? ''}`)
  args.set(flag.slice(2), value)
}

const marketplace = args.get('marketplace') ?? 'merchant-local'
const expected = args.get('expected')
if (!expected) throw new Error('--expected marketplace directory is required')
const expectedRoot = realpathSync(resolve(expected))
const expectedManifest = JSON.parse(readFileSync(resolve(expectedRoot, 'marketplace.json'), 'utf8'))
if (expectedManifest.name !== marketplace) throw new Error(`expected directory declares ${expectedManifest.name ?? 'no name'}, not ${marketplace}`)

const command = spawnSync(args.get('codex') ?? 'codex', ['plugin', 'marketplace', 'list'], { encoding: 'utf8', timeout: 10_000 })
if (command.error || command.status !== 0) throw new Error('cannot read registered Codex marketplaces')
const rows = command.stdout.split(/\r?\n/u).slice(1).map(line => line.trim()).filter(Boolean)
const row = rows.find(line => line.split(/\s+/u)[0] === marketplace)
const registeredPath = row?.slice(marketplace.length).trim()
let registeredRoot = null
try { if (registeredPath) registeredRoot = realpathSync(registeredPath) } catch { /* stale or missing registration */ }
const result = {
  ok: registeredRoot === expectedRoot,
  marketplace,
  expected_root: expectedRoot,
  registered_root: registeredRoot,
  reason: !registeredRoot ? 'marketplace_missing_or_unreadable' : registeredRoot !== expectedRoot ? 'marketplace_points_to_different_checkout' : null,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (!result.ok) process.exitCode = 1
