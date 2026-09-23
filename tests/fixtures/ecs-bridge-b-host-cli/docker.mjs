#!/usr/local/bin/node
import { readFileSync, writeFileSync } from 'node:fs'
const statePath = '/state/runtime.json'
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)
const append = value => writeFileSync('/state/docker-calls.jsonl', `${JSON.stringify(value)}\n`, { flag: 'a' })
append(args)
const oldId = `sha256:${'1'.repeat(64)}`
const bridgeId = `sha256:${'2'.repeat(64)}`
const artifact = args.includes('/state/bridge-compose.json') ? 'bridge' : 'old'
if (args[0] === 'ps' && args.includes('-q')) { process.stdout.write(`${state.containerId}\n`); process.exit(0) }
if (args[0] === 'inspect' && args[1] !== 'image') {
  const runtime = state.runtime
  const document = JSON.parse(readFileSync(`/state/${runtime}-compose.json`, 'utf8'))
  const api = document.services.api
  const item = { Id: state.containerId, Name: '/merchant-api-1', Image: runtime === 'bridge' ? bridgeId : oldId,
    State: { Running: true }, Config: { Image: api.image, Env: Object.entries(api.environment).map(([k,v]) => `${k}=${v}`), Entrypoint: null, Cmd: null,
      Labels: { 'com.docker.compose.project': 'merchant-production' } }, Mounts: [] }
  process.stdout.write(`${JSON.stringify([item])}\n`); process.exit(0)
}
if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(`${args.at(-1).includes('sha256:22222222') ? bridgeId : oldId}\n`); process.exit(0)
}
if (args[0] === 'compose' && args.includes('config')) {
  const path = args[args.indexOf('-f') + 1]
  process.stdout.write(readFileSync(path, 'utf8')); process.exit(0)
}
if (args[0] === 'compose' && args.includes('up')) {
  if (args.includes('migrate')) { append({ forbidden: 'migrate' }); process.exit(71) }
  state.runtime = artifact
  state.containerId = artifact === 'bridge' ? 'b'.repeat(64) : 'a'.repeat(64)
  writeFileSync(statePath, `${JSON.stringify(state)}\n`)
  process.exit(0)
}
process.stderr.write(`unsupported docker fixture invocation: ${args.join(' ')}\n`)
process.exit(64)
