#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const assert = (ok, message) => { if (!ok) throw new Error(message) }

function portRange(value, label) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value ?? ''))
  assert(match, `${label} is not a numeric port or range`)
  const start = Number(match[1]), end = Number(match[2] ?? match[1])
  assert(start > 0 && end >= start && end <= 65535, `${label} is outside the valid port range`)
  return { start, end }
}

function addressFamily(address) {
  if (!address || address === '*' || address === '0.0.0.0' || address === '::') return 'wildcard'
  if (isIP(address) === 4) return `ipv4:${address}`
  if (isIP(address) === 6) {
    if (address.toLowerCase().startsWith('::ffff:')) return 'wildcard'
    return `ipv6:${new URL(`http://[${address}]/`).hostname.toLowerCase()}`
  }
  throw new Error('published port has an invalid host IP')
}

function overlaps(left, right) {
  if (left.protocol !== right.protocol) return false
  const addressA = addressFamily(left.hostIp), addressB = addressFamily(right.hostIp)
  if (addressA !== 'wildcard' && addressB !== 'wildcard' && addressA !== addressB) return false
  return left.start <= right.end && right.start <= left.end
}

export function findPublishedPortConflicts(compose, containers, candidateProject, replacementServices = [], allowedGatewayId = '', hostListeners = []) {
  assert(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(candidateProject ?? ''), 'candidate project is invalid')
  assert(compose?.services && typeof compose.services === 'object' && !Array.isArray(compose.services) && Object.keys(compose.services).length > 0,
    'rendered Compose must contain services')
  assert(Array.isArray(replacementServices) && new Set(replacementServices).size === replacementServices.length, 'replacement service list is invalid')
  assert(replacementServices.every(service => Object.hasOwn(compose.services, service)), 'replacement service is absent from rendered Compose')
  const replacing = new Set(replacementServices)
  const replacementBindings = []
  const candidate = []
  for (const [service, definition] of Object.entries(compose?.services ?? {})) {
    assert(definition?.network_mode !== 'host', `service ${service} uses host networking; published-port conflicts cannot be bounded`)
    assert(definition?.ports === undefined || Array.isArray(definition.ports), `service ${service} has an invalid ports list`)
    for (const port of definition?.ports ?? []) {
      assert(port && typeof port === 'object', `service ${service} has an invalid rendered port mapping`)
      if (port.published === undefined || port.published === null || port.published === '') continue
      const range = portRange(port.published, `service ${service} published port`)
      const target = portRange(port.target, `service ${service} target port`)
      assert(range.end - range.start === target.end - target.start, `service ${service} published and target port ranges differ`)
      const hostIp = String(port.host_ip ?? '')
      addressFamily(hostIp)
      const protocol = String(port.protocol ?? 'tcp').toLowerCase()
      assert(['tcp', 'udp', 'sctp'].includes(protocol), `service ${service} has an unsupported published-port protocol`)
      candidate.push({ service, hostIp, protocol, ...range })
    }
  }

  const conflicts = []
  for (let index = 0; index < candidate.length; index += 1) {
    for (let other = index + 1; other < candidate.length; other += 1) {
      if (overlaps(candidate[index], candidate[other])) {
        conflicts.push({ ...candidate[index], owner: `candidate service ${candidate[other].service}` })
      }
    }
  }
  for (const container of containers) {
    if (container.State?.Running !== true) continue
    const labels = container.Config?.Labels ?? {}
    const isReplacement = labels['com.docker.compose.project'] === candidateProject && replacing.has(labels['com.docker.compose.service'])
    const isGatewayHandoff = container.Id === allowedGatewayId
    if (container.HostConfig?.NetworkMode === 'host' && !isReplacement && candidate.length > 0) {
      for (const requested of candidate) conflicts.push({ ...requested, owner: `host-network container ${String(container.Name ?? container.Id).replace(/^\//, '')}` })
      continue
    }
    for (const [targetProtocol, bindings] of Object.entries(container.HostConfig?.PortBindings ?? {})) {
      const [target, protocol = 'tcp'] = targetProtocol.split('/')
      portRange(target, 'running container target port')
      for (const binding of bindings ?? []) {
        if (!binding?.HostPort) continue
        const occupied = { hostIp: String(binding.HostIp ?? ''), protocol, ...portRange(binding.HostPort, 'running container host port') }
        if (isReplacement || (isGatewayHandoff && ['80', '443'].includes(String(occupied.start)) && occupied.start === occupied.end)) {
          replacementBindings.push(occupied)
          continue
        }
        for (const requested of candidate) {
          if (overlaps(requested, occupied)) {
            conflicts.push({ ...requested, owner: `container ${String(container.Name ?? container.Id).replace(/^\//, '')} (${occupied.hostIp || '*'}:${occupied.start}-${occupied.end}/${protocol})` })
          }
        }
      }
    }
  }
  for (const listener of hostListeners) {
    const occupied = { hostIp: listener.hostIp ?? '', protocol: listener.protocol, start: Number(listener.port), end: Number(listener.port) }
    portRange(occupied.start, 'host listener port')
    assert(['tcp', 'udp', 'sctp'].includes(occupied.protocol), 'host listener protocol is invalid')
    if (replacementBindings.some(binding => overlaps(binding, occupied))) continue
    for (const requested of candidate) {
      if (overlaps(requested, occupied)) conflicts.push({ ...requested, owner: `host listener ${occupied.hostIp || '*'}:${occupied.start}/${occupied.protocol}` })
    }
  }
  return conflicts
}

function parseListeners(output) {
  return output.split('\n').map(line => {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || !['tcp', 'udp', 'sctp'].includes(fields[0])) return null
    const protocol = fields[0]
    const endpoint = fields[3]
    const split = endpoint.startsWith('[') ? endpoint.lastIndexOf(']:') : endpoint.lastIndexOf(':')
    if (split < 0) throw new Error('host socket inventory returned an invalid listener')
    const hostIp = endpoint.startsWith('[') ? endpoint.slice(1, split) : endpoint.slice(0, split)
    const port = endpoint.slice(split + (endpoint.startsWith('[') ? 2 : 1))
    if (port === '*') return null
    portRange(port, 'host listener port')
    addressFamily(hostIp)
    return { protocol, hostIp, port }
  }).filter(Boolean)
}

export function main(argv = process.argv.slice(2)) {
  const [candidateProject, serviceList, allowedGatewayId = ''] = argv
  assert(argv.length >= 2 && argv.length <= 3 && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(candidateProject ?? ''), 'candidate Compose project is required')
  const replacementServices = serviceList.split(/[\s,]+/).filter(Boolean)
  assert(replacementServices.length > 0 && replacementServices.every(service => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(service)), 'replacement service list is invalid')
  assert(!allowedGatewayId || /^[0-9a-f]{64}$/.test(allowedGatewayId), 'allowed gateway ID must be a full Docker ID')
  const compose = JSON.parse(readFileSync(0, 'utf8'))
  const ids = execFileSync('/usr/bin/docker', ['ps', '-q', '--no-trunc'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
  const containers = ids.length ? JSON.parse(execFileSync('/usr/bin/docker', ['inspect', ...ids], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) : []
  const socketOutput = execFileSync('/usr/sbin/ss', ['-H', '-ltnuS'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  const conflicts = findPublishedPortConflicts(compose, containers, candidateProject, replacementServices, allowedGatewayId, parseListeners(socketOutput))
  assert(conflicts.length === 0, `candidate host port conflict: ${conflicts.map(item => `${item.service} ${item.hostIp || '*'}:${item.start}-${item.end}/${item.protocol} is owned by ${item.owner}`).join('; ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : 'candidate host port preflight failed'); process.exitCode = 1 }
}
