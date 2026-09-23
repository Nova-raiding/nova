#!/usr/bin/env node
// B-only, read-only Docker observation. Never exports Docker config/env values.
// The resulting root-only document is unsigned review material; the protected
// preidentity helper must independently recapture and sign before cutover.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVICES = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const SHA = /^[0-9a-f]{64}$/u
const IMAGE = /^sha256:[0-9a-f]{64}$/u
const dockerBinary = process.platform === 'darwin' ? 'docker' : '/usr/bin/docker'
const assert = (value, message) => { if (!value) throw new Error(message) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  : JSON.stringify(value)

function options(args, keys) {
  assert(args.length % 2 === 0, 'exact key/value options are required')
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    assert(keys.includes(args[index]) && !Object.hasOwn(result, args[index]) && args[index + 1], 'unknown, duplicate or missing option')
    result[args[index]] = args[index + 1]
  }
  return result
}
function protectedPath(path, exists = true) {
  assert(typeof path === 'string' && path.startsWith('/') && resolve(path) === path, 'canonical absolute path required')
  if (process.platform === 'darwin') return
  assert(process.geteuid?.() === 0, 'root is required for old runtime evidence')
  let cursor = exists ? path : dirname(path)
  assert(realpathSync(cursor) === cursor, 'protected path must not resolve through symlinks')
  if (exists) {
    const file = lstatSync(path)
    assert(file.isFile() && file.uid === 0 && (file.mode & 0o077) === 0, 'root-only regular file is required')
    cursor = dirname(path)
  }
  while (cursor !== '/') {
    const stat = lstatSync(cursor)
    assert(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'root-owned non-writable path chain required')
    cursor = dirname(cursor)
  }
}
function docker(args) { return execFileSync(dockerBinary, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim() }
function inspect(id) {
  const value = JSON.parse(docker(['inspect', id]))[0]
  assert(value?.Id && SHA.test(value.Id) && IMAGE.test(value.Image) && value.State?.Running === true, 'running full-ID Docker identity is required')
  return value
}
function networkSpec(value) {
  return Object.entries(value.NetworkSettings?.Networks ?? {}).map(([name, item]) => ({ name, id: item.NetworkID, aliases: [...(item.Aliases ?? [])].sort() })).sort((a, b) => a.name.localeCompare(b.name))
}
function fingerprint(value) {
  const networks = networkSpec(value)
  assert(networks.length > 0 && networks.every(item => SHA.test(item.id)), 'Docker network identities are incomplete')
  return { id: value.Id, image_id: value.Image, config_sha256: digest(Buffer.from(canonical(value.Config))), host_sha256: digest(Buffer.from(canonical(value.HostConfig))), mounts_sha256: digest(Buffer.from(canonical(value.Mounts ?? []))), networks }
}
export function summarizeOldRuntime(oldContainers, gateway, sourceGitSha, nginxConfig) {
  assert(/^[0-9a-f]{40}$/u.test(sourceGitSha), 'full old Git SHA is required')
  assert(Array.isArray(oldContainers) && oldContainers.length === SERVICES.length, 'exact seven old containers are required')
  const services = oldContainers.map((value, index) => {
    const service = SERVICES[index]
    assert(value.Name === `/merchant-production-${service}-1` && value.State?.Running === true, `old name or running state changed: ${service}`)
    assert(!value.Config?.Labels?.['com.docker.compose.project'] && !value.Config?.Labels?.['com.docker.compose.service'], `old service gained Compose ownership: ${service}`)
    const expected = service === 'api-replica' ? ['merchant-production_default', 'storenova-demo-e0'] : ['merchant-production_default']
    assert(JSON.stringify(networkSpec(value).map(item => item.name)) === JSON.stringify(expected), `old network graph changed: ${service}`)
    if (service === 'api-replica') {
      const release = (value.Config?.Env ?? []).find(item => item.startsWith('RELEASE_GIT_SHA='))?.slice('RELEASE_GIT_SHA='.length)
      assert(release === sourceGitSha, 'old API runtime Git SHA does not match reviewed source')
    }
    return { service, container: value.Name.slice(1), ...fingerprint(value) }
  })
  assert(gateway.State?.Running === true && !services.some(item => item.id === gateway.Id), 'external gateway is not distinct and running')
  assert(gateway.Name === '/local-pilot-gateway-https-20260914202431', 'external gateway name changed')
  const ports = Object.values(gateway.HostConfig?.PortBindings ?? {}).flatMap(values => values ?? []).map(item => String(item.HostPort))
  assert(ports.includes('80') && ports.includes('443') && networkSpec(gateway).some(item => item.name === 'merchant-production_default'), 'external gateway 80/443/API network changed')
  const upstream = /^\s*upstream\s+pilot_api\s*\{([^}]*)\}/mu.exec(nginxConfig)?.[1]
  const servers = [...(upstream ?? '').matchAll(/^\s*server\s+([^;]+);\s*$/gmu)].map(item => item[1].trim())
  assert(servers.length === 1 && servers[0] === 'merchant-production-api-replica-1:8787 resolve' && /^\s*proxy_pass\s+http:\/\/pilot_api(?:\/[^;\s]*)?;\s*$/mu.test(nginxConfig), 'gateway upstream is not the historical API DNS name')
  const api = services.find(item => item.service === 'api-replica')
  const worker = services.find(item => item.service === 'worker-sync')
  assert(api.image_id !== worker.image_id && services.filter(item => item.service.startsWith('worker-')).every(item => item.image_id === worker.image_id), 'old API/worker image set changed')
  assert(gateway.Image !== api.image_id && gateway.Image !== worker.image_id, 'external gateway image identity overlaps API/worker')
  return { source_git_sha: sourceGitSha, services, gateway: { name: gateway.Name.slice(1), ...fingerprint(gateway), nginx_config_sha256: digest(Buffer.from(nginxConfig)) }, preserved_image_ids: [api.image_id, worker.image_id, gateway.Image] }
}
function collectRuntime(gatewayId, sourceGitSha) {
  assert(SHA.test(gatewayId), 'full external gateway ID is required')
  const services = SERVICES.map(service => inspect(`merchant-production-${service}-1`))
  const gateway = inspect(gatewayId)
  const nginxConfig = docker(['exec', gatewayId, 'nginx', '-T'])
  return summarizeOldRuntime(services, gateway, sourceGitSha, nginxConfig)
}
async function hashFile(path) {
  const value = createHash('sha256')
  for await (const chunk of createReadStream(path)) value.update(chunk)
  return value.digest('hex')
}
function tarSmall(path, member) {
  assert(/^[A-Za-z0-9._/-]+$/u.test(member) && !member.startsWith('/') && !member.split('/').includes('..'), 'unsafe Docker archive member')
  return execFileSync('tar', ['-xOf', path, member], { maxBuffer: 16 * 1024 * 1024 })
}
async function tarMemberHash(path, member) {
  assert(/^[A-Za-z0-9._/-]+$/u.test(member) && !member.startsWith('/') && !member.split('/').includes('..'), 'unsafe Docker layer member')
  const child = spawn('tar', ['-xOf', path, member], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  const value = createHash('sha256')
  let stderr = 0
  child.stderr.on('data', chunk => { stderr += chunk.length })
  for await (const chunk of child.stdout) value.update(chunk)
  const status = await closed
  assert(status === 0 && stderr < 4096, 'Docker archive layer is unreadable')
  return value.digest('hex')
}
export async function verifyDockerSaveArchive(path, expectedImageIds) {
  protectedPath(path)
  assert(expectedImageIds.length === 3 && expectedImageIds.every(value => IMAGE.test(value)) && new Set(expectedImageIds).size === 3, 'exact old API, worker and gateway image IDs are required')
  const size = statSync(path).size
  assert(size > 0 && size <= 8 * 1024 ** 3, 'Docker save archive size is outside the reviewed bound')
  const manifest = JSON.parse(tarSmall(path, 'manifest.json').toString('utf8'))
  assert(Array.isArray(manifest) && manifest.length === 3, 'Docker save archive must contain exactly three images')
  const seen = new Set(), layerHashes = new Map()
  for (const entry of manifest) {
    assert(/^[0-9a-f]{64}\.json$/u.test(entry?.Config ?? '') && Array.isArray(entry.Layers), 'Docker save manifest config/layers are invalid')
    const imageId = `sha256:${entry.Config.slice(0, 64)}`
    assert(expectedImageIds.includes(imageId) && !seen.has(imageId), 'Docker save image ID differs from running API/worker')
    seen.add(imageId)
    const configBytes = tarSmall(path, entry.Config)
    assert(digest(configBytes) === imageId.slice(7), 'Docker save image configuration hash differs from image ID')
    const config = JSON.parse(configBytes.toString('utf8'))
    const diffIds = config.rootfs?.diff_ids
    assert(Array.isArray(diffIds) && diffIds.length === entry.Layers.length && diffIds.every(value => IMAGE.test(value)), 'Docker save rootfs layer list is invalid')
    for (let index = 0; index < entry.Layers.length; index += 1) {
      const layer = entry.Layers[index]
      if (!layerHashes.has(layer)) layerHashes.set(layer, await tarMemberHash(path, layer))
      assert(layerHashes.get(layer) === diffIds[index].slice(7), 'Docker save layer content differs from image config diffID')
    }
  }
  assert(seen.size === 3, 'Docker save archive omitted an old image')
  return { kind: 'docker-save-three-image', archive_sha256: await hashFile(path), archive_bytes: size, image_ids: [...expectedImageIds] }
}
function readEvidence(path) {
  protectedPath(path)
  const stat = statSync(path)
  assert(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024, 'old runtime evidence file is invalid')
  return JSON.parse(readFileSync(path, 'utf8'))
}
function writeEvidence(path, value) {
  protectedPath(path, false)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
async function main(args) {
  const mode = args[0]
  if (mode === 'freeze') {
    const input = options(args.slice(1), ['--output', '--gateway-id', '--source-git-sha', '--archive'])
    assert(input['--output'] && input['--gateway-id'] && input['--source-git-sha'], 'freeze requires output, gateway ID and old Git SHA')
    const runtime = collectRuntime(input['--gateway-id'], input['--source-git-sha'])
    const backup = input['--archive'] ? await verifyDockerSaveArchive(input['--archive'], runtime.preserved_image_ids) : { kind: 'not_provided' }
    const evidence = { schema_version: 'ecs-bridge-old-runtime/1', created_at: new Date().toISOString(), runtime, backup, signed: false, cutover_authorized: false }
    writeEvidence(input['--output'], evidence)
    process.stdout.write(`old runtime evidence frozen; image_backup=${backup.kind}; signing and cutover remain separate\n`)
  } else if (mode === 'verify') {
    const input = options(args.slice(1), ['--evidence', '--archive', '--recovery-plan', '--gateway-id'])
    assert(input['--evidence'] && input['--archive'] && input['--recovery-plan'] && input['--gateway-id'], 'verify requires protected evidence, archive, recovery plan and gateway ID')
    assert(SHA.test(input['--gateway-id']), 'full external gateway ID is required')
    protectedPath(input['--recovery-plan'])
    const plan = JSON.parse(readFileSync(input['--recovery-plan'], 'utf8'))
    assert(plan.kind === 'ecs-compose-rollback-capsule' && plan.database?.strategy === 'forward_only' && plan.database?.target_migration_tail === 242 && /^[0-9a-f]{40}$/u.test(plan.target?.git_sha ?? ''), 'reviewed old recovery plan is required')
    const evidence = readEvidence(input['--evidence'])
    assert(evidence.schema_version === 'ecs-bridge-old-runtime/1' && evidence.signed === false && evidence.cutover_authorized === false, 'unexpected old runtime evidence schema/authority')
    assert(evidence.runtime?.gateway?.id === input['--gateway-id'] && evidence.runtime?.source_git_sha === plan.target.git_sha, 'frozen old gateway or Git SHA differs from recovery plan')
    const runtime = collectRuntime(input['--gateway-id'], plan.target.git_sha)
    assert(canonical(runtime) === canonical(evidence.runtime), 'old running containers or gateway drifted since freeze')
    const backup = await verifyDockerSaveArchive(input['--archive'], runtime.preserved_image_ids)
    assert(canonical(backup) === canonical(evidence.backup), 'old Docker save backup differs from frozen evidence')
    process.stdout.write('old B runtime and three-image backup precheck passed; signed journal, DB 242 and public readiness still required\n')
  } else throw new Error('expected freeze or verify')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('old B runtime evidence rejected; no production state changed'); process.exitCode = 1 })
}
