#!/usr/bin/env node
// Real Docker proof of the historical, label-free container-name handoff.
// No production host, external listener, or business database is touched.
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const marker = randomUUID().replaceAll('-', '')
const network = `bridge-unlabeled-${marker}`
const name = `bridge-api-replica-${marker}`
const candidateName = `bridge-candidate-${marker}`
const parkedName = `bridge-parked-${marker}`
const image = 'alpine:3'
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim()
const inspect = id => JSON.parse(docker('inspect', id))[0]
const resolve = () => docker('run', '--rm', '--pull=never', '--network', network, image, 'getent', 'hosts', name).split(/\s+/u)[0]
let networkCreated = false
let oldId
let candidateId
const restoreOld = () => {
  if (!oldId) return
  const old = inspect(oldId)
  if (candidateId) {
    const candidate = inspect(candidateId)
    if (candidate.State.Running) docker('stop', '--time', '5', candidateId)
    if (candidate.Name === `/${name}`) docker('rename', candidateId, candidateName)
  }
  if (old.Name !== `/${name}`) docker('rename', oldId, name)
  if (!inspect(oldId).State.Running) docker('start', oldId)
  const restored = inspect(oldId)
  if (restored.Id !== oldId || !restored.State.Running || restored.Name !== `/${name}` || resolve() !== restored.NetworkSettings.Networks[network].IPAddress) {
    throw new Error('original label-free container identity or Docker DNS was not restored')
  }
}

try {
  docker('network', 'create', network)
  networkCreated = true
  oldId = docker('run', '-d', '--pull=never', '--name', name, '--network', network, image, 'sleep', '300')
  candidateId = docker('create', '--pull=never', '--name', candidateName, '--network', network, image, 'sleep', '300')
  const old = inspect(oldId), candidate = inspect(candidateId)
  if (old.Config.Labels?.['com.docker.compose.project'] || old.Config.Labels?.['com.docker.compose.service']) throw new Error('old fixture unexpectedly has Compose ownership labels')
  if (old.Name !== `/${name}` || !old.State.Running || candidate.State.Running || resolve() !== old.NetworkSettings.Networks[network].IPAddress) throw new Error('old unlabeled DNS fixture is invalid')

  // Failure after parking old but before candidate starts must be reversible.
  docker('stop', '--time', '5', oldId)
  docker('rename', oldId, parkedName)
  restoreOld()

  // Successful code-name handoff and a later failed acceptance must both
  // retain the same old ID and restore the old DNS identity without deletion.
  docker('stop', '--time', '5', oldId)
  docker('rename', oldId, parkedName)
  docker('rename', candidateId, name)
  docker('start', candidateId)
  const switched = inspect(candidateId)
  if (switched.Id !== candidateId || resolve() !== switched.NetworkSettings.Networks[network].IPAddress) throw new Error('candidate did not acquire the old Docker DNS name')
  restoreOld()
  console.log('PASS: unlabeled same-name Docker handoff and two partial-failure restorations preserve old ID and DNS')
} finally {
  try { restoreOld() } catch { /* preserve observed failure; exact IDs remain for inspection */ }
  for (const id of [candidateId, oldId]) if (id) {
    try {
      const value = inspect(id)
      if ([`/${name}`, `/${candidateName}`, `/${parkedName}`].includes(value.Name) && value.NetworkSettings.Networks?.[network]) docker('rm', '-f', id)
    } catch { /* exact-ID cleanup is intentionally fail-closed */ }
  }
  if (networkCreated) {
    try { docker('network', 'rm', network) } catch { console.error(`isolated network requires inspection: ${network}`) }
  }
}
