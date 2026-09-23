#!/usr/local/bin/node
// Fixed-path Docker double for the signed seven-container takeover CLI.
import fs from 'node:fs'

const args = process.argv.slice(2)
fs.appendFileSync('/state/docker-argv.jsonl', `${JSON.stringify(args)}\n`)
const path = '/state/unlabeled-docker.json'
const rows = JSON.parse(fs.readFileSync(path, 'utf8'))
const save = () => fs.writeFileSync(path, JSON.stringify(rows), { mode: 0o600 })
const byIdOrName = value => rows.find(row => row.Id === value || row.Name === `/${value}`)
const fail = message => { process.stderr.write(`${message}\n`); process.exit(1) }

if (args[0] === 'ps') {
  const all = args.includes('--all')
  let visible = rows.filter(row => all || row.State.Running)
  const filterAt = args.indexOf('--filter')
  if (filterAt >= 0) {
    const name = /^name=\^\/(.+)\$$/u.exec(args[filterAt + 1] ?? '')?.[1]
    if (!name) fail('invalid exact-name filter')
    visible = visible.filter(row => row.Name === `/${name}`)
  }
  process.stdout.write(visible.map(row => `${row.Id}\n`).join(''))
} else if (args[0] === 'inspect') {
  const row = byIdOrName(args[1])
  if (!row) fail('unlabeled container not found')
  process.stdout.write(JSON.stringify([row]))
} else if (args[0] === 'image' && args[1] === 'inspect') {
  const ref = args.at(-1)
  const row = rows.find(value => value.Config.Image === ref)
  if (!row) fail('unlabeled image not found')
  process.stdout.write(`${row.Image}\n`)
} else if (args[0] === 'compose' && args.includes('config')) {
  const services = Object.fromEntries(rows.filter(row => row.Name.startsWith('/bridge-')).map(row => [row.Name.slice('/bridge-'.length, -2), { image: row.Config.Image }]))
  process.stdout.write(JSON.stringify({ services }))
} else if (['stop', 'start', 'rename'].includes(args[0])) {
  const mutation = Number(fs.existsSync('/state/unlabeled-mutation-count') ? fs.readFileSync('/state/unlabeled-mutation-count', 'utf8') : '0') + 1
  fs.writeFileSync('/state/unlabeled-mutation-count', String(mutation), { mode: 0o600 })
  const injected = Number(fs.existsSync('/state/unlabeled-fail-at') ? fs.readFileSync('/state/unlabeled-fail-at', 'utf8') : '0')
  const after = fs.existsSync('/state/unlabeled-fail-after')
  if (mutation === injected && !after) fail('injected Docker failure before mutation')
  const id = args[0] === 'stop' ? args.at(-1) : args[1]
  const row = byIdOrName(id)
  if (!row) fail('unlabeled mutation ID not found')
  if (args[0] === 'rename') {
    if (rows.some(other => other.Id !== row.Id && other.Name === `/${args[2]}`)) fail('Docker name conflict')
    row.Name = `/${args[2]}`
  } else row.State.Running = args[0] === 'start'
  save()
  if (row.Name === '/merchant-production-api-replica-1' && args[0] === 'start') {
    if (row.Id === '11'.padStart(64, '0')) fs.writeFileSync('/state/bridge-public', '', { mode: 0o600 })
    else try { fs.unlinkSync('/state/bridge-public') } catch {}
  }
  if (mutation === injected && after) fail('injected Docker failure after mutation')
  process.stdout.write(`${row.Id}\n`)
} else fail('unexpected unlabeled Docker call')
