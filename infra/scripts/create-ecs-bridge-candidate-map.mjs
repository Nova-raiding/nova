#!/usr/bin/env node
// Run only after a dedicated, empty candidate Compose project creates seven
// stopped containers. The protected recovery helper signs their exact IDs.
import { execFileSync } from 'node:child_process'
import { constants, closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'

const services = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const [project, output] = process.argv.slice(2)
if (!/^[a-z][a-z0-9_-]{1,62}$/u.test(project ?? '') || !output?.startsWith('/') || output.includes('/../')) throw new Error('candidate project or output path is unsafe')
const dockerBinary = process.platform === 'darwin' ? 'docker' : '/usr/bin/docker'
const docker = args => execFileSync(dockerBinary, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim()
const ids = docker(['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`]).split(/\s+/u).filter(Boolean)
if (ids.length !== services.length || new Set(ids).size !== services.length) throw new Error('candidate project must contain exactly seven containers')
const byService = new Map()
for (const id of ids) {
  if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error('candidate container ID is not full length')
  const value = JSON.parse(docker(['inspect', id]))[0]
  const service = value?.Config?.Labels?.['com.docker.compose.service']
  if (value?.Id !== id || value.State?.Running !== false || value.Config?.Labels?.['com.docker.compose.project'] !== project || !services.includes(service) || byService.has(service) || !/^\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.Name ?? '')) throw new Error('candidate service identity is invalid')
  byService.set(service, { service, container: value.Name.slice(1) })
}
const mapping = services.map(service => byService.get(service))
if (mapping.some(value => !value)) throw new Error('candidate service map is incomplete')
const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
try { writeFileSync(fd, `${JSON.stringify(mapping, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
process.stdout.write('seven stopped fixed-image candidate containers mapped for signed capture\n')
