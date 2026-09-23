#!/usr/bin/env node
// Explicit operator-triggered, isolated real-Docker partial-switch rehearsal.
// The database prefix is synthetic; this does not attest production readiness.
import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSignedSnapshot, transitionJournal, verifyBridgeRecoveryAuthorization } from '../infra/protected/ecs-preidentity-recovery.mjs'

const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const sha = letter => letter.repeat(64)
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const image = tag => {
  const inspected = JSON.parse(docker(['image', 'inspect', tag]))[0]
  const ref = inspected?.RepoDigests?.[0]
  if (!/^\S+@sha256:[0-9a-f]{64}$/.test(ref ?? '')) throw new Error(`isolated image lacks immutable local RepoDigest: ${tag}`)
  return { ref, id: inspected.Id }
}
const oldApi = image('nginx:alpine'), newApi = image('nginx:1.27-alpine')
const oldWorker = image('alpine:3'), newWorker = image('alpine:3.20')
if (oldApi.id === newApi.id || oldWorker.id === newWorker.id) throw new Error('isolated old and candidate images must differ')
const project = `bridgeprobe${process.pid}`
const directory = mkdtempSync(join(tmpdir(), 'merchant-bridge-real-docker-'))
const oldPath = join(directory, 'old.yml'), candidatePath = join(directory, 'candidate.yml')
const release = (id, git, manifest, images) => ({ releaseId: id, gitSha: git.repeat(40), manifestSha256: sha(manifest), imageSetDigest: `sha256:${sha(images)}` })
const oldRelease = release('isolated-old', 'a', 'b', 'c'), candidateRelease = release('isolated-bridge', 'd', 'e', 'f')
const environment = value => `      RELEASE_ID: ${value.releaseId}\n      RELEASE_GIT_SHA: ${value.gitSha}\n      RELEASE_MANIFEST_SHA256: ${value.manifestSha256}\n      RELEASE_IMAGE_SET_DIGEST: ${value.imageSetDigest}\n`
const compose = (api, worker, identity) => `services:\n  api:\n    image: ${api.ref}\n    environment:\n${environment(identity)}  worker-sync:\n    image: ${worker.ref}\n    command: ["sleep", "300"]\n`
writeFileSync(oldPath, compose(oldApi, oldWorker, oldRelease))
writeFileSync(candidatePath, compose(newApi, newWorker, candidateRelease))
const composeCommand = (file, args) => docker(['compose', '-p', project, '-f', file, ...args])
const collect = () => {
  const rows = ['api', 'worker-sync'].map(service => {
    const id = composeCommand(oldPath, ['ps', '-q', service])
    const x = JSON.parse(docker(['inspect', id]))[0]
    const configHash = hash(Buffer.from(canonical({ image: x.Config?.Image, env: [...(x.Config?.Env ?? [])].sort(), entrypoint: x.Config?.Entrypoint ?? null, cmd: x.Config?.Cmd ?? null, mounts: (x.Mounts ?? []).map(({ Destination, Type, RW }) => ({ Destination, Type, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)) })))
    const env = Object.fromEntries((x.Config?.Env ?? []).map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)] }))
    return { service, id: x.Id, imageId: x.Image, configHash, state: x.State?.Running ? 'running' : 'stopped', name: x.Name.replace(/^\//u, ''), releaseIdentity: { release_id: env.RELEASE_ID, release_git_sha: env.RELEASE_GIT_SHA, manifest_sha256: env.RELEASE_MANIFEST_SHA256, image_set_digest: env.RELEASE_IMAGE_SET_DIGEST } }
  })
  return { composeProject: project, containers: rows, inventory: rows.map(row => ({ id: row.id, name: row.name, image_id: row.imageId, config_hash: row.configHash })) }
}
let started = false
try {
  composeCommand(oldPath, ['up', '-d', '--no-build', '--pull', 'never', 'api', 'worker-sync'])
  started = true
  const before = collect()
  const database = { version: 242, historySha256: sha('1'), invalidConcurrentIndexes: [] }
  const recovery = { ...oldRelease, composeSha256: hash(Buffer.from(compose(oldApi, oldWorker, oldRelease))), envSha256: sha('2'), imageDigestsSha256: sha('3'), migrationTail: 242, allowedPrefixSha256: { 242: database.historySha256 }, services: ['api', 'worker-sync'] }
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const nonce = 'isolated_nonce_abcdefghijklmnop'
  const observed = { ...before, database, candidateImageIds: [newApi.id, newWorker.id], candidateServiceImageIds: { api: newApi.id, 'worker-sync': newWorker.id }, candidateExclusiveRunning: false, candidateIdentityRunning: false }
  let journal = createSignedSnapshot(observed, { attemptId: 'isolated_attempt_abcdefghijklmnop', deploymentNonce: nonce, keyId: 'isolated-only', candidate: candidateRelease, recovery, mode: 'bridge_code_only' }, keys.privateKey, keys.publicKey)
  journal = transitionJournal(journal, 'nonce_consumed', keys.privateKey, keys.publicKey)
  journal = transitionJournal(journal, 'bridge_cutover_started', keys.privateKey, keys.publicKey)
  composeCommand(candidatePath, ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'api'])
  const partial = collect()
  if (partial.containers[0].imageId !== newApi.id || partial.containers[1].imageId !== oldWorker.id) throw new Error('real Docker partial switch did not occur')
  verifyBridgeRecoveryAuthorization(journal, { observed: partial, database, deploymentNonce: nonce, recovery }, keys.publicKey)
  composeCommand(oldPath, ['up', '-d', '--no-build', '--pull', 'never', 'api', 'worker-sync'])
  const restored = collect()
  if (restored.containers[0].imageId !== oldApi.id || restored.containers[1].imageId !== oldWorker.id) throw new Error('real Docker old images were not restored')
  if (restored.containers[0].configHash !== before.containers[0].configHash || restored.containers[1].configHash !== before.containers[1].configHash) throw new Error('real Docker old runtime configuration changed')
  process.stdout.write('PASS: isolated real Docker Compose partial B switch restored exact old images/config under signed bridge authorization; DB and public identity were simulated.\n')
} finally {
  if (started) composeCommand(oldPath, ['down', '--remove-orphans'])
  rmSync(directory, { recursive: true, force: true })
}
