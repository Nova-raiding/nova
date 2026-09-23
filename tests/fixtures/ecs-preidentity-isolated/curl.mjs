#!/usr/local/bin/node
import fs from 'node:fs'

const args = process.argv.slice(2)
fs.appendFileSync('/state/curl-argv.jsonl', `${JSON.stringify(args)}\n`)
const url = args.at(-1)
if (url.endsWith('/releasez')) {
  const candidate = fs.existsSync('/state/bridge-public')
  process.stdout.write(JSON.stringify({ data: { release: candidate
    ? { release_id: 'release-a9', release_git_sha: 'a'.repeat(40), manifest_sha256: 'b'.repeat(64), image_set_digest: `sha256:${'c'.repeat(64)}` }
    : { release_id: 'release-48', release_git_sha: 'd'.repeat(40), manifest_sha256: 'e'.repeat(64), image_set_digest: `sha256:${'f'.repeat(64)}` } } }))
} else if (url.endsWith('/livez') || url.endsWith('/readyz')) process.stdout.write('{}')
else process.exit(2)
