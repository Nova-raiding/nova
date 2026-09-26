#!/usr/bin/env node
// Read-only Docker discovery of the seven historical label-free services.
// This writes only service names, not inspect JSON, environment or secrets.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const services = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const [output, gatewayId] = process.argv.slice(2)
if (!output?.startsWith('/') || resolve(output) !== output || !/^[0-9a-f]{64}$/u.test(gatewayId ?? '')) throw new Error('canonical output path and full external gateway ID are required')
if (process.platform !== 'darwin' && process.geteuid?.() !== 0) throw new Error('old service map must be frozen by root')
if (process.platform !== 'darwin') {
  let cursor = dirname(output)
  if (realpathSync(cursor) !== cursor) throw new Error('old map parent is not canonical')
  while (cursor !== '/') {
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('old map parent chain is not protected')
    cursor = dirname(cursor)
  }
}
const dockerBinary = process.platform === 'darwin' ? 'docker' : '/usr/bin/docker'
const docker = args => execFileSync(dockerBinary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const inspect = id => {
  const value = JSON.parse(docker(['inspect', id]))[0]
  if (value?.Id !== id || value.State?.Running !== true || !/^sha256:[0-9a-f]{64}$/u.test(value.Image ?? '')) throw new Error('running immutable Docker identity changed')
  return value
}
const gateway = inspect(gatewayId)
const ports = Object.values(gateway.HostConfig?.PortBindings ?? {}).flatMap(values => values ?? []).map(value => String(value.HostPort))
if (!ports.includes('80') || !ports.includes('443') || !gateway.NetworkSettings?.Networks?.['merchant-production_default']) throw new Error('external gateway does not own reviewed 80/443 and API network')
const mapping = services.map(service => {
  const container = `merchant-production-${service}-1`
  const ids = docker(['ps', '-q', '--no-trunc', '--filter', `name=^/${container}$`]).split(/\s+/u).filter(Boolean)
  if (ids.length !== 1 || !/^[0-9a-f]{64}$/u.test(ids[0])) throw new Error(`historical service is missing or ambiguous: ${service}`)
  const value = inspect(ids[0])
  if (value.Name !== `/${container}` || value.Config?.Labels?.['com.docker.compose.project'] || value.Config?.Labels?.['com.docker.compose.service']) throw new Error(`historical service name or ownership changed: ${service}`)
  const networks = Object.keys(value.NetworkSettings?.Networks ?? {}).sort()
  const expected = service === 'api-replica' ? ['merchant-production_default', 'storenova-demo-e0'] : ['merchant-production_default']
  if (JSON.stringify(networks) !== JSON.stringify(expected)) throw new Error(`historical service network graph changed: ${service}`)
  const networkIdentity = Object.entries(value.NetworkSettings.Networks).map(([name, net]) => ({
    name, id: net.NetworkID, aliases: [...(net.Aliases ?? [])].sort(),
  })).sort((a, b) => a.name.localeCompare(b.name))
  if (networkIdentity.some(net => !/^[0-9a-f]{64}$/u.test(net.id))) throw new Error(`historical network identity is invalid: ${service}`)
  return { service, container, container_id: value.Id, image_id: value.Image,
    config_sha256: digest(value.Config), host_sha256: digest(value.HostConfig), networks_sha256: digest(networkIdentity) }
})
const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
try { writeFileSync(fd, `${JSON.stringify(mapping, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
process.stdout.write('reviewed seven-service old fingerprint capsule frozen; external gateway inspected, no environment data emitted\n')
