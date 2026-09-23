import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createSignedSnapshot,
  productionApiBaseUrl,
  recoverUnlabeledPairs,
  switchUnlabeledPairs,
  transitionJournal,
  verifyBridgeRecoveryAuthorization,
  verifyRecoveryAuthorization,
} from '../infra/protected/ecs-preidentity-recovery.mjs'

const sha = (letter: string) => letter.repeat(64)
const image = (letter: string) => `sha256:${sha(letter)}`
const git = (letter: string) => letter.repeat(40)
const now = new Date('2026-09-21T12:00:00.000Z')
const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const observed = {
  composeProject: 'merchant-production',
  candidateImageIds: [image('c')],
  containers: [
    { service: 'api', id: 'a'.repeat(64), imageId: image('1'), configHash: sha('2'), state: 'running' },
    { service: 'worker-sync', id: 'b'.repeat(64), imageId: image('3'), configHash: sha('4'), state: 'running' },
  ],
  inventory: [
    { id: 'a'.repeat(64), name: 'api', image_id: image('1'), config_hash: sha('2') },
    { id: 'b'.repeat(64), name: 'worker-sync', image_id: image('3'), config_hash: sha('4') },
  ],
  database: { version: 219, historySha256: sha('5'), invalidConcurrentIndexes: [] },
}
const binding = {
  attemptId: 'attempt_abcdefghijklmnop', deploymentNonce: 'nonce_abcdefghijklmnopqr', keyId: 'release-security-2026',
  candidate: { releaseId: 'release-a9', gitSha: git('a'), manifestSha256: sha('b'), imageSetDigest: image('c') },
  recovery: { releaseId: 'release-48', gitSha: git('d'), manifestSha256: sha('e'), imageSetDigest: image('f'), composeSha256: sha('6'), envSha256: sha('7'), imageDigestsSha256: sha('8'), migrationTail: 233, allowedPrefixSha256: { 219: sha('5'), 223: sha('9'), 233: sha('a') }, services: ['api', 'worker-sync'] },
}

describe('protected ECS pre-identity recovery', () => {
  it('signs only the bounded seven-container unlabeled takeover and recovers every partial action', () => {
    const services = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
    const pairs = services.map((service, index) => {
      const oldId = (index + 1).toString(16).padStart(64, '0')
      const candidateId = (index + 17).toString(16).padStart(64, '0')
      const oldName = `merchant-production-${service}-1`
      return { service, old_name: oldName, candidate_name: `bridge-${service}-1`, parked_name: `${oldName}.parked.release-a9`,
        old: { id: oldId, image_id: image('1'), config_sha256: sha('2'), host_sha256: sha('3'), networks: [{ name: 'merchant-production_default', id: sha('4'), aliases: [] }] },
        candidate: { id: candidateId, image_id: image('c'), config_sha256: sha('5'), host_sha256: sha('6'), networks: [{ name: 'merchant-production_default', id: sha('4'), aliases: [] }] } }
    })
    const sevenObserved = {
      ...observed, database: { version: 242, historySha256: sha('5'), invalidConcurrentIndexes: [] },
      containers: pairs.map(pair => ({ service: pair.service, id: pair.old.id, imageId: pair.old.image_id, configHash: sha('2'), state: 'running' })),
      inventory: [...pairs.map(pair => ({ id: pair.old.id, name: pair.old_name, image_id: pair.old.image_id, config_hash: sha('2') })), { id: sha('9'), name: 'external-gateway', image_id: image('7'), config_hash: sha('8') }],
      candidateImageIds: [image('c')], candidateServiceImageIds: Object.fromEntries(services.map(service => [service, image('c')])), unlabeledTakeover: pairs,
      unlabeledGateway: { id: sha('9'), image_id: image('7'), config_sha256: sha('8'), host_sha256: sha('9'), nginx_config_sha256: sha('a'), networks: [{ name: 'merchant-production_default', id: sha('4'), aliases: [] }] },
    }
    const sevenBinding = { ...binding, mode: 'bridge_unlabeled_code_only' as const,
      recovery: { ...binding.recovery, migrationTail: 242, allowedPrefixSha256: { 242: sha('5') }, services } }
    const snapshot = createSignedSnapshot(sevenObserved, sevenBinding, keys.privateKey, keys.publicKey, now)
    expect(snapshot.unlabeled_takeover).toEqual(pairs)
    expect(() => createSignedSnapshot({ ...sevenObserved, unlabeledTakeover: pairs.slice(1) }, sevenBinding, keys.privateKey, keys.publicKey, now)).toThrow(/seven frozen/u)
    const state = () => new Map(pairs.flatMap(pair => [[pair.old.id, { name: pair.old_name, running: true }], [pair.candidate.id, { name: pair.candidate_name, running: false }]]))
    const actions = (containers: ReturnType<typeof state>, faultAt = Infinity, after = false) => {
      let count = 0
      const apply = (fn: () => void) => {
        count += 1
        if (!after && count === faultAt) throw new Error('injected Docker fault')
        fn()
        if (after && count === faultAt) throw new Error('injected Docker fault after mutation')
      }
      return {
        inspect: (id: string) => ({ ...containers.get(id)! }),
        stop: (id: string) => apply(() => { containers.get(id)!.running = false }),
        start: (id: string) => apply(() => { containers.get(id)!.running = true }),
        rename: (id: string, name: string) => apply(() => {
          if ([...containers].some(([other, value]) => other !== id && value.name === name)) throw new Error('Docker name conflict')
          containers.get(id)!.name = name
        }),
      }
    }
    for (const after of [false, true]) for (let position = 1; position <= 28; position += 1) {
      const containers = state()
      expect(() => switchUnlabeledPairs(pairs, actions(containers, position, after))).toThrow(/injected Docker fault/u)
      recoverUnlabeledPairs(pairs, actions(containers))
      for (const pair of pairs) {
        expect(containers.get(pair.old.id)).toEqual({ name: pair.old_name, running: true })
        expect(containers.get(pair.candidate.id)).toEqual({ name: pair.candidate_name, running: false })
      }
    }
    const switched = state()
    switchUnlabeledPairs(pairs, actions(switched))
    expect(switched.get(pairs[0]!.candidate.id)).toEqual({ name: pairs[0]!.old_name, running: true })
    recoverUnlabeledPairs(pairs, actions(switched))
    expect(switched.get(pairs[0]!.old.id)).toEqual({ name: pairs[0]!.old_name, running: true })
  })
  it('signs a separate code-only 242 bridge state machine and authorizes bounded partial restore', () => {
    const bridgeObserved = {
      ...observed,
      database: { version: 242, historySha256: sha('5'), invalidConcurrentIndexes: [] },
      candidateServiceImageIds: { api: image('c'), 'worker-sync': image('d') },
      candidateImageIds: [image('c'), image('d')],
    }
    const bridgeBinding = { ...binding, mode: 'bridge_code_only' as const, recovery: { ...binding.recovery, migrationTail: 242, allowedPrefixSha256: { 242: sha('5') } } }
    let journal = createSignedSnapshot(bridgeObserved, bridgeBinding, keys.privateKey, keys.publicKey, now)
    expect(journal.deployment_mode).toBe('bridge_code_only')
    expect(journal.candidate_service_image_ids).toEqual(bridgeObserved.candidateServiceImageIds)
    journal = transitionJournal(journal, 'nonce_consumed', keys.privateKey, keys.publicKey, now)
    expect(() => transitionJournal(journal, 'migration_started', keys.privateKey, keys.publicKey, now)).toThrow(/transition/u)
    journal = transitionJournal(journal, 'bridge_cutover_started', keys.privateKey, keys.publicKey, now)
    const partial = {
      composeProject: 'merchant-production',
      containers: [
        { service: 'api', id: 'e'.repeat(64), imageId: image('c'), configHash: sha('a'), state: 'running', releaseIdentity: { release_id: binding.candidate.releaseId, release_git_sha: binding.candidate.gitSha, manifest_sha256: binding.candidate.manifestSha256, image_set_digest: binding.candidate.imageSetDigest } },
        observed.containers[1]!,
      ],
      inventory: [
        { ...observed.inventory[0], id: 'e'.repeat(64), image_id: image('c'), config_hash: sha('a') },
        observed.inventory[1]!,
      ],
    }
    const input = { observed: partial, database: bridgeObserved.database, deploymentNonce: binding.deploymentNonce, recovery: bridgeBinding.recovery }
    expect(verifyBridgeRecoveryAuthorization(journal, input, keys.publicKey, now)).toEqual({ authorized: true, targetMigration: 242 })
    expect(verifyBridgeRecoveryAuthorization(journal, { ...input, observed: { ...partial, containers: [{ service: 'api', missing: true }, observed.containers[1]!], inventory: [observed.inventory[1]!] } }, keys.publicKey, now)).toEqual({ authorized: true, targetMigration: 242 })
    expect(() => verifyBridgeRecoveryAuthorization(journal, { ...input, database: { ...bridgeObserved.database, version: 243 } }, keys.publicKey, now)).toThrow(/schema 242/u)
    expect(() => verifyBridgeRecoveryAuthorization(journal, { ...input, observed: { ...partial, containers: [{ ...partial.containers[0]!, imageId: image('9') }, partial.containers[1]!] } }, keys.publicKey, now)).toThrow(/neither original nor/u)
    expect(() => verifyBridgeRecoveryAuthorization(journal, { ...input, observed: { ...partial, inventory: [...partial.inventory, { id: 'f'.repeat(64), name: 'unknown', image_id: image('f'), config_hash: sha('f') }] } }, keys.publicKey, now)).toThrow(/unknown running/u)
    const recovering = transitionJournal(journal, 'bridge_recovery_started', keys.privateKey, keys.publicKey, now)
    expect(verifyBridgeRecoveryAuthorization(recovering, input, keys.publicKey, now)).toEqual({ authorized: true, targetMigration: 242 })
    const partiallyRestored = { ...input, observed: { ...partial, containers: [{ ...observed.containers[0]!, id: 'f'.repeat(64) }, observed.containers[1]!], inventory: [{ ...observed.inventory[0]!, id: 'f'.repeat(64) }, observed.inventory[1]!] } }
    expect(verifyBridgeRecoveryAuthorization(recovering, partiallyRestored, keys.publicKey, now)).toEqual({ authorized: true, targetMigration: 242 })
    expect(() => verifyBridgeRecoveryAuthorization(journal, partiallyRestored, keys.publicKey, now)).toThrow(/neither original nor/u)
    expect(() => transitionJournal(recovering, 'bridge_recovery_verified', keys.privateKey, keys.publicKey, now)).toThrow(/transition/u)
    const runtimeVerified = transitionJournal(recovering, 'bridge_runtime_recovery_verified', keys.privateKey, keys.publicKey, now)
    expect(verifyBridgeRecoveryAuthorization(runtimeVerified, partiallyRestored, keys.publicKey, now)).toEqual({ authorized: true, targetMigration: 242 })
    const verified = transitionJournal(runtimeVerified, 'bridge_recovery_verified', keys.privateKey, keys.publicKey, now)
    expect(() => verifyBridgeRecoveryAuthorization(verified, input, keys.publicKey, now)).toThrow(/phase/u)
  })
  it('normalizes safe HTTPS API prefixes and rejects unsafe URLs before recovery mutation', () => {
    expect(productionApiBaseUrl('https://yxsona.com/api')).toBe('https://yxsona.com/api')
    expect(productionApiBaseUrl('https://yxsona.com/api/')).toBe('https://yxsona.com/api')
    expect(productionApiBaseUrl('https://yxsona.com')).toBe('https://yxsona.com')
    for (const value of ['http://yxsona.com/api', 'https://user@yxsona.com/api', 'https://yxsona.com/api?q=1', 'https://yxsona.com/api#x', 'https://yxsona.com/api//v1', 'https://yxsona.com/%2e%2e/admin']) expect(() => productionApiBaseUrl(value)).toThrow()
    const source = readFileSync('infra/protected/ecs-preidentity-recovery.mjs', 'utf8')
    const validation = source.indexOf("productionApiBaseUrl(get('--production-api-base-url'))")
    const artifactHash = source.indexOf("digest(readRegular(compose)) === recovery.composeSha256")
    const recoveryStarted = source.indexOf("transitionJournal(document, 'recovery_started'")
    expect(validation).toBeGreaterThan(0)
    expect(validation).toBeLessThan(recoveryStarted)
    expect(artifactHash).toBeGreaterThan(validation)
    expect(artifactHash).toBeLessThan(recoveryStarted)
    expect(validation).toBeLessThan(source.indexOf("'never', 'migrate'"))
    expect(source).toContain('`${productionBase}/livez`')
    expect(source).toContain('`${productionBase}/readyz`')
    expect(source).toContain('`${productionBase}/releasez`')
  })
  it('pins child executables, cleans child environments, hides DB credentials from argv, and requires inherited FD 9', () => {
    const source = readFileSync('infra/protected/ecs-preidentity-recovery.mjs', 'utf8')
    for (const path of ['/usr/bin/docker', '/usr/bin/psql', '/usr/bin/flock', '/usr/bin/curl']) expect(source).toContain(path)
    expect(source).not.toMatch(/execFileSync\(['"](?:docker|psql|flock|curl)/u)
    expect(source).not.toContain("[databaseUrl, '-X'")
    expect(source).not.toContain("'--database-url'")
    expect(source).not.toContain('ECS_PREIDENTITY_LOCK_HELD')
    expect(source).toContain('fstatSync(9)')
    expect(source).toContain("spawnSync(BIN.flock, ['-n', '9']")
    expect(source).toContain('env: {}')
    expect(source).toContain('unknown option:')
    expect(source).toContain('duplicate option:')
    expect(source).toContain('fsyncSync(fd)')
    expect(source).toContain('fsyncSync(parentFd)')
  })

  it('fails closed when the CLI is executed from an uninstalled mutable path', () => {
    const result = spawnSync(process.execPath, ['infra/protected/ecs-preidentity-recovery.mjs', 'capture'], { encoding: 'utf8', env: {} })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/must run as root|must run from \/usr\/local\/libexec\/merchant\/ecs-preidentity-recovery/u)
  })
  it('keeps the isolated replay digest-pinned, networkless, socketless, and explicit about stubs', () => {
    const replay = readFileSync('tests/run-ecs-preidentity-isolated-cli.sh', 'utf8')
    expect(replay).toContain("node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32")
    expect(replay).toContain('--network none')
    expect(replay).not.toContain('/var/run/docker.sock')
    expect(replay).toContain('Docker/psql stubs; no real Docker recovery claimed')
  })
  it('signs only independently observed workload and database state', () => {
    const snapshot = createSignedSnapshot(observed, binding, keys.privateKey, keys.publicKey, now)
    expect(snapshot.schema_version).toBe('ecs-preidentity-recovery/1')
    expect(snapshot.phase).toBe('captured')
    expect(snapshot.predeployment_workload.container_set_digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(snapshot.predeployment_workload.inventory_digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(snapshot.database_before).toEqual({ migration_version: 219, migration_history_sha256: sha('5') })
    expect(snapshot.deployment_nonce_sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(snapshot).not.toHaveProperty('deployment_nonce')
    expect(snapshot.signature_base64).toBeTruthy()
  })

  it('allows only monotonic protected journal transitions', () => {
    const captured = createSignedSnapshot(observed, binding, keys.privateKey, keys.publicKey, now)
    const consumed = transitionJournal(captured, 'nonce_consumed', keys.privateKey, keys.publicKey, now)
    const migrating = transitionJournal(consumed, 'migration_started', keys.privateKey, keys.publicKey, now)
    expect(migrating.phase).toBe('migration_started')
    expect(() => transitionJournal(migrating, 'captured', keys.privateKey, keys.publicKey, now)).toThrow(/transition/u)
    const complete = transitionJournal(migrating, 'migration_complete', keys.privateKey, keys.publicKey, now)
    expect(() => transitionJournal(complete, 'runtime_cutover_started', keys.privateKey, keys.publicKey, now)).not.toThrow()
  })

  it('makes recovery a one-shot terminal journal branch', () => {
    let snapshot = createSignedSnapshot(observed, binding, keys.privateKey, keys.publicKey, now)
    snapshot = transitionJournal(snapshot, 'nonce_consumed', keys.privateKey, keys.publicKey, now)
    snapshot = transitionJournal(snapshot, 'migration_started', keys.privateKey, keys.publicKey, now)
    const started = transitionJournal(snapshot, 'recovery_started', keys.privateKey, keys.publicKey, now)
    expect(() => verifyRecoveryAuthorization(started, {} as never, keys.publicKey, now)).toThrow(/phase/u)
    const verified = transitionJournal(started, 'recovery_verified', keys.privateKey, keys.publicKey, now)
    expect(() => transitionJournal(verified, 'recovery_started', keys.privateKey, keys.publicKey, now)).toThrow(/transition/u)
  })

  it('authorizes forward recovery only before cutover with the exact unchanged containers and nonce', () => {
    let snapshot = createSignedSnapshot(observed, binding, keys.privateKey, keys.publicKey, now)
    snapshot = transitionJournal(snapshot, 'nonce_consumed', keys.privateKey, keys.publicKey, now)
    snapshot = transitionJournal(snapshot, 'migration_started', keys.privateKey, keys.publicKey, now)
    const result = verifyRecoveryAuthorization(snapshot, {
      observed, deploymentNonce: binding.deploymentNonce, recovery: binding.recovery,
      database: { version: 223, historySha256: sha('9'), invalidConcurrentIndexes: [] },
    }, keys.publicKey, now)
    expect(result).toEqual({ authorized: true, targetMigration: 233 })
  })

  it.each([
    ['changed container', { observed: { ...observed, containers: [{ ...observed.containers[0]!, imageId: image('9') }, observed.containers[1]!] } }],
    ['unknown running container', { observed: { ...observed, inventory: [...observed.inventory, { id: 'c'.repeat(64), name: 'parallel-candidate', image_id: image('c'), config_hash: sha('c') }] } }],
    ['wrong nonce', { deploymentNonce: 'nonce_different_abcdefghijk' }],
    ['partial candidate cutover', { candidateContainersRunning: true }],
    ['invalid concurrent index', { database: { version: 222, historySha256: sha('9'), invalidConcurrentIndexes: ['ops_incident_timeline_workspace_created_id_idx'] } }],
    ['non-prefix history', { database: { version: 223, historySha256: sha('0'), invalidConcurrentIndexes: [] } }],
  ])('fails closed for %s', (_label, override) => {
    let snapshot = createSignedSnapshot(observed, binding, keys.privateKey, keys.publicKey, now)
    snapshot = transitionJournal(snapshot, 'nonce_consumed', keys.privateKey, keys.publicKey, now)
    snapshot = transitionJournal(snapshot, 'migration_started', keys.privateKey, keys.publicKey, now)
    const input = {
      observed, deploymentNonce: binding.deploymentNonce, recovery: binding.recovery, candidateContainersRunning: false,
      database: { version: 223, historySha256: sha('9'), invalidConcurrentIndexes: [] },
      ...override,
    }
    expect(() => verifyRecoveryAuthorization(snapshot, input, keys.publicKey, now)).toThrow()
  })

  it('never authorizes after runtime cutover starts', () => {
    let snapshot = createSignedSnapshot(observed, binding, keys.privateKey, keys.publicKey, now)
    for (const phase of ['nonce_consumed', 'migration_started', 'migration_complete', 'runtime_cutover_started']) snapshot = transitionJournal(snapshot, phase, keys.privateKey, keys.publicKey, now)
    expect(() => verifyRecoveryAuthorization(snapshot, {
      observed, deploymentNonce: binding.deploymentNonce, recovery: binding.recovery,
      database: { version: 233, historySha256: sha('a'), invalidConcurrentIndexes: [] },
    }, keys.publicKey, now)).toThrow(/phase/u)
  })
})
