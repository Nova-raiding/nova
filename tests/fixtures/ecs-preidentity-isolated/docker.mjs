#!/usr/local/bin/node
import fs from 'node:fs'

const args = process.argv.slice(2)
const idA = 'a'.repeat(64), idB = 'b'.repeat(64)
const imageA = `sha256:${'1'.repeat(64)}`, imageB = `sha256:${'3'.repeat(64)}`, candidate = `sha256:${'c'.repeat(64)}`
fs.appendFileSync('/state/docker-argv.jsonl', `${JSON.stringify(args)}\n`)

function inspect(id) {
  if (id === 'c'.repeat(64)) return { Id: id, Image: `sha256:${'4'.repeat(64)}`, Name: '/unknown-runtime', State: { Running: true }, Config: { Image: 'unknown', Env: [], Entrypoint: null, Cmd: ['sleep'] }, Mounts: [] }
  return { Id: id, Image: id === idA ? imageA : imageB, Name: id === idA ? '/legacy-api' : '/legacy-worker', State: { Running: true }, Config: { Image: 'legacy', Env: [], Entrypoint: null, Cmd: ['sleep'] }, Mounts: [] }
}

if (args[0] === 'ps' && args.includes('--filter')) process.stdout.write(args.join(' ').includes('legacy-api') ? `${idA}\n` : args.join(' ').includes('legacy-worker') ? `${idB}\n` : '')
else if (args[0] === 'ps') process.stdout.write(`${idA}\n${idB}\n${fs.existsSync('/state/extra') ? `${'c'.repeat(64)}\n` : ''}`)
else if (args[0] === 'inspect') process.stdout.write(JSON.stringify([inspect(args[1])]))
else if (args[0] === 'image' && args[1] === 'inspect') process.stdout.write(`${candidate}\n`)
else process.exit(2)
