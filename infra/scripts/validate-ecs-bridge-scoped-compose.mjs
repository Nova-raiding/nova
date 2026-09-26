#!/usr/bin/env node
// Compare the precreated seven-service bridge against the reviewed full B
// render without passing rendered secrets through process environment/argv.
import { execFileSync } from 'node:child_process'

const [fullPath, scopedPath, candidateProject] = process.argv.slice(2)
if (!fullPath?.startsWith('/') || !scopedPath?.startsWith('/') || !/^bridge[a-z0-9_-]{1,56}$/u.test(candidateProject ?? '')) throw new Error('bridge Compose input is invalid')
const docker = process.platform === 'darwin' ? 'docker' : '/usr/bin/docker'
const config = (project, path) => JSON.parse(execFileSync(docker, ['compose', '-p', project, '-f', path, 'config', '--format', 'json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
const full = config('merchant-production', fullPath)
const scoped = config(candidateProject, scopedPath)
const names = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const required = (ok, message) => { if (!ok) throw new Error(message) }
required(JSON.stringify(Object.keys(scoped.services ?? {}).sort()) === JSON.stringify(names), 'B scoped Compose must contain exactly seven services')
required(scoped.networks?.default?.external === true && scoped.networks.default.name === 'merchant-production_default', 'B scoped Compose must reuse old API/worker network')
required(scoped.networks?.['storenova-demo-e0']?.external === true && scoped.networks['storenova-demo-e0'].name === 'storenova-demo-e0', 'B scoped API must retain second old network')
for (const name of names) {
  const reviewed = full.services?.[name], candidate = scoped.services[name]
  required(reviewed && candidate && /^[^\s]+@sha256:[0-9a-f]{64}$/u.test(candidate.image ?? ''), `B service image is not immutable: ${name}`)
  const strip = value => { const copy = structuredClone(value); delete copy.networks; delete copy.depends_on; return copy }
  required(JSON.stringify(strip(reviewed)) === JSON.stringify(strip(candidate)), `B scoped service differs from reviewed full service: ${name}`)
  required(!candidate.depends_on && !(candidate.ports ?? []).length && candidate.environment?.BRIDGE_SCHEMA_COMPATIBILITY_MODE === 'prefix_242_or_244', `B scoped runtime is unsafe: ${name}`)
  const expected = name === 'api-replica' ? ['default', 'storenova-demo-e0'] : ['default']
  required(JSON.stringify(Object.keys(candidate.networks ?? {}).sort()) === JSON.stringify(expected.sort()), `B scoped network attachments differ: ${name}`)
}
process.stdout.write('seven-service B scoped Compose matches reviewed full B runtime\n')
