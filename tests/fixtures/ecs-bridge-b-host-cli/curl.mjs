#!/usr/local/bin/node
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const url = args.at(-1)
if (!url.startsWith('https://yxsona.com/')) process.exit(65)
if (url.endsWith('/livez') || url.endsWith('/readyz')) { process.stdout.write('{"ok":true}\n'); process.exit(0) }
if (url.endsWith('/releasez')) {
  const { runtime } = JSON.parse(readFileSync('/state/runtime.json', 'utf8'))
  const identity = JSON.parse(readFileSync(`/state/${runtime}-identity.json`, 'utf8'))
  process.stdout.write(`${JSON.stringify({ data: { release: identity } })}\n`); process.exit(0)
}
process.exit(65)
