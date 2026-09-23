#!/usr/local/bin/node
import fs from 'node:fs'

const args = process.argv.slice(2)
const idA = 'a'.repeat(64), idB = 'b'.repeat(64)
const imageA = `sha256:${'1'.repeat(64)}`, imageB = `sha256:${'3'.repeat(64)}`, candidate = `sha256:${'c'.repeat(64)}`
fs.appendFileSync('/state/docker-argv.jsonl', `${JSON.stringify(args)}\n`)

if (fs.existsSync('/state/bridge-mode')) {
  const partial = fs.existsSync('/state/bridge-partial') && !fs.existsSync('/state/bridge-restored')
  const missing = fs.existsSync('/state/bridge-missing') && !fs.existsSync('/state/bridge-restored')
  const allCandidate = fs.existsSync('/state/bridge-all-candidate')
  const partialRestore = fs.existsSync('/state/bridge-partial-restore')
  const apiId = fs.existsSync('/state/bridge-restored') || partialRestore ? 'f'.repeat(64) : partial || allCandidate ? 'e'.repeat(64) : idA
  const workerId = allCandidate ? 'g'.repeat(64) : idB
  const identity = ['RELEASE_ID=release-a9', `RELEASE_GIT_SHA=${'a'.repeat(40)}`, `RELEASE_MANIFEST_SHA256=${'b'.repeat(64)}`, `RELEASE_IMAGE_SET_DIGEST=sha256:${'c'.repeat(64)}`]
  const inspectBridge = id => ({ Id: id, Image: id === 'e'.repeat(64) ? candidate : id === 'g'.repeat(64) ? `sha256:${'d'.repeat(64)}` : id === idB ? imageB : imageA, Name: id === idB || id === 'g'.repeat(64) ? '/legacy-worker' : '/legacy-api', State: { Running: true }, Config: { Image: id === 'e'.repeat(64) ? 'new-api' : id === 'g'.repeat(64) ? 'new-worker' : 'legacy', Env: id === 'e'.repeat(64) ? identity : [], Entrypoint: null, Cmd: ['sleep'] }, Mounts: [] })
  if (args[0] === 'ps' && args.includes('--filter')) {
    process.stdout.write(args.join(' ').includes('legacy-api') ? (missing ? '' : `${apiId}\n`) : args.join(' ').includes('legacy-worker') ? `${workerId}\n` : '')
  } else if (args[0] === 'ps') {
    process.stdout.write(`${missing ? '' : `${apiId}\n`}${workerId}\n`)
  } else if (args[0] === 'inspect') {
    process.stdout.write(JSON.stringify([inspectBridge(args[1])]))
  } else if (args[0] === 'image' && args[1] === 'inspect') {
    const ref = args.at(-1)
    process.stdout.write(`${ref.startsWith('new-api@') ? candidate : ref.startsWith('new-worker@') ? `sha256:${'d'.repeat(64)}` : ref.startsWith('old-api@') ? imageA : imageB}\n`)
  } else if (args[0] === 'compose' && args.includes('up')) {
    if (fs.existsSync('/state/bridge-up-fail')) { fs.writeFileSync('/state/bridge-partial-restore', ''); process.exit(17) }
    fs.writeFileSync('/state/bridge-restored', '')
    try { fs.unlinkSync('/state/bridge-public') } catch {}
  } else process.exit(2)
  process.exit(0)
}

function inspect(id) {
  if (id === 'c'.repeat(64)) return { Id: id, Image: `sha256:${'4'.repeat(64)}`, Name: '/unknown-runtime', State: { Running: true }, Config: { Image: 'unknown', Env: [], Entrypoint: null, Cmd: ['sleep'] }, Mounts: [] }
  return { Id: id, Image: id === idA ? imageA : imageB, Name: id === idA ? '/legacy-api' : '/legacy-worker', State: { Running: true }, Config: { Image: 'legacy', Env: [], Entrypoint: null, Cmd: ['sleep'] }, Mounts: [] }
}

if (args[0] === 'ps' && args.includes('--filter')) process.stdout.write(args.join(' ').includes('legacy-api') ? `${idA}\n` : args.join(' ').includes('legacy-worker') ? `${idB}\n` : '')
else if (args[0] === 'ps') process.stdout.write(`${idA}\n${idB}\n${fs.existsSync('/state/extra') ? `${'c'.repeat(64)}\n` : ''}`)
else if (args[0] === 'inspect') process.stdout.write(JSON.stringify([inspect(args[1])]))
else if (args[0] === 'image' && args[1] === 'inspect') process.stdout.write(`${candidate}\n`)
else process.exit(2)
