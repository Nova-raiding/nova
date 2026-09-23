import './setup.mjs'
import fs from 'node:fs'

const services = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const sha = value => value.repeat(64)
const image = value => `sha256:${sha(value)}`
const oldMap = services.map(service => ({ service, container: `merchant-production-${service}-1` }))
const candidateMap = services.map(service => ({ service, container: `bridge-${service}-1` }))
const networks = service => service === 'api-replica'
  ? { 'merchant-production_default': { NetworkID: sha('4'), Aliases: ['api-replica'] }, 'storenova-demo-e0': { NetworkID: sha('5'), Aliases: ['merchant-api'] } }
  : { 'merchant-production_default': { NetworkID: sha('4'), Aliases: [] } }
const pairs = services.map((service, index) => {
  const oldId = (index + 1).toString(16).padStart(64, '0'), candidateId = (index + 17).toString(16).padStart(64, '0')
  const isApi = service === 'api-replica'
  const candidateEnv = ['BRIDGE_SCHEMA_COMPATIBILITY_MODE=prefix_242_or_244',
    ...(isApi ? ['RELEASE_ID=release-a9', `RELEASE_GIT_SHA=${'a'.repeat(40)}`, `RELEASE_MANIFEST_SHA256=${sha('b')}`, `RELEASE_IMAGE_SET_DIGEST=${image('c')}`] : [])]
  const oldName = oldMap[index].container, candidateName = candidateMap[index].container
  const make = (id, name, running, candidate) => ({ Id: id, Name: `/${name}`, Image: candidate ? image(isApi ? 'c' : 'd') : image(isApi ? '1' : '3'),
    State: { Running: running }, Config: { Image: candidate ? `${isApi ? 'new-api' : 'new-worker'}@${image(isApi ? 'c' : 'd')}` : `${isApi ? 'old-api' : 'old-worker'}@${image(isApi ? '1' : '3')}`, Env: candidate ? candidateEnv : [], Entrypoint: null, Cmd: ['sleep', '300'], Labels: candidate ? { 'com.docker.compose.project': 'bridge-prebuild' } : {} },
    HostConfig: { NetworkMode: 'merchant-production_default', RestartPolicy: { Name: 'unless-stopped' } }, Mounts: [],
    NetworkSettings: { Networks: networks(service) } })
  return { service, old: make(oldId, oldName, true, false), candidate: make(candidateId, candidateName, false, true) }
})
const plan = JSON.parse(fs.readFileSync('/state/bridge-plan.json', 'utf8'))
plan.target.services = services
fs.writeFileSync('/state/bridge-unlabeled-plan.json', JSON.stringify(plan), { mode: 0o600 })
fs.writeFileSync('/state/unlabeled-old-map.json', JSON.stringify(oldMap), { mode: 0o600 })
fs.writeFileSync('/state/unlabeled-candidate-map.json', JSON.stringify(candidateMap), { mode: 0o600 })
fs.writeFileSync('/state/unlabeled-candidate-compose.yml', `services:\n${services.map(service => `  ${service}:\n    image: ${service === 'api-replica' ? 'new-api' : 'new-worker'}@${image(service === 'api-replica' ? 'c' : 'd')}\n`).join('')}`, { mode: 0o600 })
fs.writeFileSync('/state/unlabeled-candidate-digests.json', JSON.stringify(Object.fromEntries(services.map(service => [service, `${service === 'api-replica' ? 'new-api' : 'new-worker'}@${image(service === 'api-replica' ? 'c' : 'd')}`]))), { mode: 0o600 })
const gateway = { Id: sha('9'), Name: '/old-external-gateway', Image: image('7'), State: { Running: true },
  Config: { Image: `old-gateway@${image('7')}`, Env: [], Entrypoint: null, Cmd: ['nginx'], Labels: {} },
  HostConfig: { NetworkMode: 'merchant-production_default', PortBindings: { '8080/tcp': [{ HostPort: '80' }], '8443/tcp': [{ HostPort: '443' }] } }, Mounts: [],
  NetworkSettings: { Networks: { 'merchant-production_default': { NetworkID: sha('4'), Aliases: [] } } } }
fs.writeFileSync('/state/unlabeled-docker.json', JSON.stringify([...pairs.flatMap(pair => [pair.old, pair.candidate]), gateway]), { mode: 0o600 })
fs.writeFileSync('/state/bridge-mode', '', { mode: 0o600 })
