import { mkdtemp, chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  authorizeBridgeBMutation,
  authorizeBridgeBRecovery,
  BRIDGE_B_RUNTIME_SERVICES,
  createBridgeBSnapshot,
  preflightBridgeBMutation,
  productionApiBaseUrl,
  recordBridgeBAttemptBinding,
  transitionBridgeBJournal,
} from '../infra/protected/ecs-bridge-b-transition.mjs'
import {
  advanceBridgeBJournal,
  consumeBridgeBJournalNonce,
  initializeBridgeBJournal,
} from '../infra/protected/ecs-bridge-b-journal-store.mjs'

const sha = (letter: string) => letter.repeat(64)
const image = (letter: string) => `sha256:${sha(letter)}`
const git = (letter: string) => letter.repeat(40)
const now = new Date('2026-09-24T04:00:00.000Z')
const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const deploymentNonce = 'nonce_BridgeB_abcdefghijklmnopqrstuvwxyz'
const bridge = { releaseId: 'bridge-b-242', gitSha: git('a'), manifestSha256: sha('b'), imageSetDigest: image('c') }
const observed = {
  composeProject: 'merchant-production',
  containers: [{ service: 'api', containerName: 'merchant-api-1', id: 'a'.repeat(64), imageId: image('1'), configHash: sha('2'), state: 'running' }],
  inventory: [{ id: 'a'.repeat(64), name: 'api', image_id: image('1'), config_hash: sha('2') }],
  bridgeImageIds: [image('3')], bridgeIdentityRunning: false, bridgeExclusiveContainersRunning: false,
  database: { version: 242, historySha256: sha('4'), invalidConcurrentIndexes: [] },
}
const binding = {
  attemptId: 'attempt_BridgeB_abcdefghijkl', deploymentNonce, bridge, keyId: 'production-release-2026',
  bridgeArtifacts: { compose_sha256: sha('5'), env_sha256: sha('6'), image_digests_sha256: sha('7'), services: ['api'] },
  recoveryCapsule: { compose_sha256: sha('8'), env_sha256: sha('9'), image_digests_sha256: sha('a'), services: ['api'], target: { release_id: 'old-release-242', release_git_sha: git('e'), manifest_sha256: sha('f'), image_set_digest: image('4') } },
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const baseline = {
  workloadSha256: digest([{ service: 'api', id: 'a'.repeat(64), image_id: image('1'), config_hash: sha('2'), state: 'running' }]),
  inventorySha256: digest([{ id: 'a'.repeat(64), name: 'api', image_id: image('1'), config_hash: sha('2') }]),
}
function snapshot() { return createBridgeBSnapshot(observed, binding, keys.privateKey, keys.publicKey, now) }
function consumed() { return transitionBridgeBJournal(snapshot(), 'nonce_consumed', keys.privateKey, keys.publicKey, now) }
function mutationStarted() {
  return transitionBridgeBJournal(consumed(), 'bridge_runtime_mutation_started', keys.privateKey, keys.publicKey, now)
}
function mutationInput(overrides: Record<string, unknown> = {}) {
  return {
    deploymentNonce, composeProject: observed.composeProject, bridgeIdentity: bridge,
    bridgeImageIds: observed.bridgeImageIds, database: observed.database, baseline,
    artifacts: { composeSha256: sha('5'), envSha256: sha('6'), imageDigestsSha256: sha('7'), services: ['api'] },
    bridgeIdentityRunning: false, ...overrides,
  }
}
function recoveryInput(overrides: Record<string, unknown> = {}) {
  return {
    deploymentNonce, composeProject: observed.composeProject,
    currentBridgeIdentity: bridge, database: observed.database, baseline,
    currentApiContainer: { id: observed.containers[0].id, imageId: observed.containers[0].imageId, configHash: observed.containers[0].configHash },
    recovery: { composeSha256: sha('8'), envSha256: sha('9'), imageDigestsSha256: sha('a'), targetServices: ['api'] },
    ...overrides,
  }
}

describe('protected ECS Bridge B transition policy', () => {
  it('pins identity probes to the configured production origin and root path', () => {
    expect(productionApiBaseUrl('https://yxsona.com')).toBe('https://yxsona.com')
    expect(productionApiBaseUrl('https://yxsona.com/')).toBe('https://yxsona.com')
    for (const url of ['https://attacker.example', 'https://yxsona.com.attacker.example', 'https://yxsona.com:8443', 'https://yxsona.com/api', 'http://yxsona.com', 'https://user@yxsona.com']) {
      expect(() => productionApiBaseUrl(url)).toThrow()
    }
  })

  it('keeps Bridge B limited to API and worker runtime services', () => {
    expect(BRIDGE_B_RUNTIME_SERVICES).toEqual(['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'])
    for (const service of ['ui', 'ops-ui', 'payment-gateway', 'pilot-gateway', 'postgres', 'redis', 'migrate']) expect(BRIDGE_B_RUNTIME_SERVICES).not.toContain(service)
  })

  it('resumes a committed Bridge B nonce only for the same attempt and release identity', () => {
    const ledger = new DatabaseSync(':memory:')
    const identity = { release_id: bridge.releaseId, release_git_sha: bridge.gitSha, manifest_sha256: bridge.manifestSha256, image_set_digest: bridge.imageSetDigest }
    try {
      expect(recordBridgeBAttemptBinding(ledger, deploymentNonce, binding.attemptId, identity)).toBe(true)
      expect(recordBridgeBAttemptBinding(ledger, deploymentNonce, binding.attemptId, identity)).toBe(true)
      expect(() => recordBridgeBAttemptBinding(ledger, deploymentNonce, 'attempt_BridgeB_abcdefghijkl2', identity)).toThrow(/different attempt or release/u)
      expect(() => recordBridgeBAttemptBinding(ledger, deploymentNonce, binding.attemptId, { ...identity, release_id: 'bridge-b-other' })).toThrow(/different attempt or release/u)
      expect(ledger.prepare('SELECT count(*) AS count FROM bridge_b_nonce_attempts').get()).toEqual({ count: 1 })
    } finally { ledger.close() }
  })

  it.each(['ui', 'ops-ui', 'pilot-gateway', 'payment-gateway', 'postgres', 'redis', 'migrate'])('rejects non-Bridge-B service %s', service => {
    expect(() => createBridgeBSnapshot({ ...observed, containers: [{ ...observed.containers[0], service }] }, binding, keys.privateKey, keys.publicKey, now)).toThrow(/allowlist/u)
  })

  it('captures and signs only a migration-242 baseline, without retaining the nonce', () => {
    const journal = snapshot()
    expect(journal.schema_version).toBe('ecs-bridge-b-transition/1')
    expect(journal.phase).toBe('captured')
    expect(journal.database_before.migration_version).toBe(242)
    expect(journal.baseline.inventory).toEqual(observed.inventory)
    expect(journal.database_policy).toEqual({ strategy: 'no_migration', required_version: 242, schema_downgrade: false })
    expect(journal.deployment_nonce_sha256).toBeTruthy()
    expect(journal).not.toHaveProperty('deployment_nonce')
    expect(journal.signature_base64).toBeTruthy()
  })

  it.each([241, 243, 245])('refuses capture if the observed database is %i instead of 242', version => {
    expect(() => createBridgeBSnapshot({ ...observed, database: { ...observed.database, version } }, binding, keys.privateKey, keys.publicKey, now)).toThrow(/exact approved database prefix at 242/u)
  })

  it('requires the consumed phase, exact nonce, frozen release identity, images, baseline and exact 242 prefix before mutation', () => {
    expect(authorizeBridgeBMutation(consumed(), mutationInput(), keys.publicKey, now)).toEqual({ authorized: true, operation: 'compose_up_runtime_only', migrationVersion: 242, migrationCommandAllowed: false })
    expect(preflightBridgeBMutation(snapshot(), mutationInput(), keys.publicKey, now)).toEqual({ authorized: true, operation: 'preflight_only', migrationVersion: 242, migrationCommandAllowed: false })
    expect(() => authorizeBridgeBMutation(snapshot(), mutationInput(), keys.publicKey, now)).toThrow(/consumed-nonce phase/u)
    for (const override of [
      { deploymentNonce: 'nonce_wrong_abcdefghijklmnopqrstuvwxyz' },
      { bridgeIdentity: { ...bridge, gitSha: git('d') } },
      { bridgeImageIds: [image('9')] },
      { artifacts: { ...mutationInput().artifacts, composeSha256: sha('9') } },
      { artifacts: { ...mutationInput().artifacts, services: ['api', 'worker'] } },
      { database: { ...observed.database, version: 243 } },
      { database: { ...observed.database, historySha256: sha('9') } },
      { baseline: { ...baseline, inventorySha256: 'changed-inventory' } },
      { bridgeIdentityRunning: true },
    ]) expect(() => authorizeBridgeBMutation(consumed(), mutationInput(override), keys.publicKey, now)).toThrow()
  })

  it('uses a monotonic signed state graph and rejects replayed/backward transitions', () => {
    const captured = snapshot()
    const nonce = transitionBridgeBJournal(captured, 'nonce_consumed', keys.privateKey, keys.publicKey, now)
    const started = transitionBridgeBJournal(nonce, 'bridge_runtime_mutation_started', keys.privateKey, keys.publicKey, now)
    expect(started.phase).toBe('bridge_runtime_mutation_started')
    expect(() => transitionBridgeBJournal(started, 'captured', keys.privateKey, keys.publicKey, now)).toThrow(/not monotonic/u)
    expect(() => transitionBridgeBJournal(nonce, 'bridge_runtime_verified', keys.privateKey, keys.publicKey, now)).toThrow(/not monotonic/u)
    const tampered = { ...started, bridge: { ...started.bridge, release_id: 'attacker-release' } }
    expect(() => transitionBridgeBJournal(tampered, 'bridge_runtime_verified', keys.privateKey, keys.publicKey, now)).toThrow(/signature/u)
  })

  it('authorizes recovery only while the database remains at the signed 242 prefix and artifacts match', () => {
    expect(authorizeBridgeBRecovery(mutationStarted(), recoveryInput(), keys.publicKey, now)).toEqual({ authorized: true, operation: 'compose_up_old_runtime_only', migrationVersion: 242, migrationCommandAllowed: false })
    expect(() => authorizeBridgeBRecovery(consumed(), recoveryInput(), keys.publicKey, now)).toThrow(/mutation-started phase/u)
    for (const [index, override] of [
      { database: { ...observed.database, version: 243 } },
      { database: { ...observed.database, historySha256: sha('9') } },
      { deploymentNonce: 'nonce_wrong_abcdefghijklmnopqrstuvwxyz' },
      { currentBridgeIdentity: { ...bridge, manifestSha256: sha('9') } },
      { recovery: { ...recoveryInput().recovery, composeSha256: sha('9') } },
      { recovery: { ...recoveryInput().recovery, envSha256: sha('b') } },
      { recovery: { ...recoveryInput().recovery, imageDigestsSha256: sha('9') } },
      { recovery: { ...recoveryInput().recovery, targetServices: ['api', 'worker'] } },
    ].entries()) expect(() => authorizeBridgeBRecovery(mutationStarted(), recoveryInput(override), keys.publicKey, now), `override ${index}`).toThrow()
  })

  it('permits an old API during mutation-started recovery only on its captured baseline container', () => {
    const oldIdentity = { releaseId: 'old-release-242', gitSha: git('e'), manifestSha256: sha('f'), imageSetDigest: image('4') }
    expect(authorizeBridgeBRecovery(mutationStarted(), recoveryInput({ currentBridgeIdentity: oldIdentity }), keys.publicKey, now).operation).toBe('compose_up_old_runtime_only')
    expect(() => authorizeBridgeBRecovery(mutationStarted(), recoveryInput({ currentBridgeIdentity: oldIdentity, currentApiContainer: { ...recoveryInput().currentApiContainer, id: 'b'.repeat(64) } }), keys.publicKey, now)).toThrow(/exact captured baseline container/u)
    const verified = transitionBridgeBJournal(mutationStarted(), 'bridge_runtime_verified', keys.privateKey, keys.publicKey, now)
    expect(() => authorizeBridgeBRecovery(verified, recoveryInput({ currentBridgeIdentity: oldIdentity }), keys.publicKey, now)).toThrow(/verified Bridge B recovery requires the candidate API identity/u)
    const thirdIdentity = { ...oldIdentity, gitSha: git('9') }
    expect(() => authorizeBridgeBRecovery(mutationStarted(), recoveryInput({ currentBridgeIdentity: thirdIdentity }), keys.publicKey, now)).toThrow(/neither the captured Bridge B nor frozen old-runtime identity/u)
  })

  it('persists nonce consumption atomically and rejects replay or stale phase advancement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-b-journal-'))
    await chmod(dir, 0o700)
    const path = join(dir, 'attempt.json')
    try {
      await initializeBridgeBJournal(path, snapshot(), keys.publicKey, now)
      expect((await readFile(path, 'utf8')).includes(deploymentNonce)).toBe(false)
      const consumed = await consumeBridgeBJournalNonce(path, deploymentNonce, keys.privateKey, keys.publicKey, now)
      expect(consumed.phase).toBe('nonce_consumed')
      await expect(consumeBridgeBJournalNonce(path, deploymentNonce, keys.privateKey, keys.publicKey, now)).rejects.toThrow(/already been consumed/u)
      await expect(advanceBridgeBJournal(path, 'captured', 'nonce_consumed', keys.privateKey, keys.publicKey, now)).rejects.toThrow(/expected phase captured/u)
      await expect(initializeBridgeBJournal(path, snapshot(), keys.publicKey, now)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(JSON.parse(await readFile(path, 'utf8')).phase).toBe('nonce_consumed')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('fails closed for a pre-existing journal lock and for symlink journals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-b-journal-'))
    await chmod(dir, 0o700)
    const path = join(dir, 'attempt.json')
    try {
      await initializeBridgeBJournal(path, snapshot(), keys.publicKey, now)
      await writeFile(`${path}.lock`, 'active')
      await expect(consumeBridgeBJournalNonce(path, deploymentNonce, keys.privateKey, keys.publicKey, now)).rejects.toThrow(/locked/u)
      await rm(`${path}.lock`)
      await rm(path)
      await symlink(join(dir, 'missing-target'), path)
      await expect(consumeBridgeBJournalNonce(path, deploymentNonce, keys.privateKey, keys.publicKey, now)).rejects.toThrow(/regular file/u)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('fails closed on expired journals and invalid concurrent indexes', () => {
    const expired = snapshot()
    expect(() => transitionBridgeBJournal(expired, 'nonce_consumed', keys.privateKey, keys.publicKey, new Date('2026-09-26T05:00:00Z'))).toThrow(/expired/u)
    expect(() => createBridgeBSnapshot({ ...observed, database: { ...observed.database, invalidConcurrentIndexes: ['idx_bad'] } }, binding, keys.privateKey, keys.publicKey, now)).toThrow(/invalid concurrent index/u)
  })
})
