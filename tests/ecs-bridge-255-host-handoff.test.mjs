import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { reviewBridge255HostHandoff } from '../infra/protected/ecs-bridge-255-host-handoff.mjs'
import { produceBridge255Pg17Restore } from '../infra/protected/ecs-bridge-255-pg17-restore.mjs'
import { createSignedBridge255PreviewPlan, runSignedBridge255Preview,
  verifySignedBridge255PreviewPlan } from '../infra/protected/ecs-bridge-255-isolated-preview.mjs'
import { validateBridge255Plan } from '../infra/protected/ecs-bridge-255-review.mjs'

const h = char => char.repeat(64)
const sha = data => createHash('sha256').update(data).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).filter(key => key !== 'signature_base64').sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const key = generateKeyPairSync('ed25519')
const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const signed = body => ({ ...body, signature_base64: sign(null, Buffer.from(canonical(body)), key.privateKey).toString('base64') })
const now = new Date('2026-09-28T04:02:00.000Z')

function fixture() {
  const identity = char => ({ release_id: `release-${char}`, git_sha: char.repeat(40),
    manifest_sha256: h(char), image_set_digest: `sha256:${h(char)}` })
  const artifacts = char => ({ identity: identity(char), compose_sha256: h(char),
    env_sha256: h(char), image_digests_sha256: h(char) })
  const services = ['api', 'api-replica', 'pilot-gateway', 'postgres', 'redis',
    'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-sync']
  const plan = { schema_version: 'ecs-bridge-255-plan/1', attempt_id: 'attempt_abcdefghijklmnop',
    project: 'merchant-demo-85575f9c', lock_path: '/var/lib/merchant-release-security/production-deploy.lock',
    nonce_sha256: h('0'), old_demo: artifacts('b'), bridge_254_255: artifacts('c'),
    candidate_255: artifacts('d'), recovery_255: artifacts('e'),
    old_demo_services: services, recovery_255_services: services, candidate_255_services: services,
    database: { strategy: 'forward_only', schema_downgrade: false, preserve_volumes: true,
      prefix_254_sha256: h('1'), prefix_255_sha256: h('2') }, pg17_image_ref: `sha256:${h('f')}` }
  const frozen = { database: { name: 'merchant', oid: 16384,
    system_identifier_sha256: h('3'), history_sha256: plan.database.prefix_254_sha256 },
  public_route: { release_id: plan.bridge_254_255.identity.release_id,
    git_sha: plan.bridge_254_255.identity.git_sha },
  postgres: { compose_project: plan.project } }
  const signedSourcePlan = signed({ freeze: frozen, key_id: 'production-evidence' })
  const directory = mkdtempSync(join(tmpdir(), 'bridge255-host-'))
  const backupPath = join(directory, 'before-upgrade-254.dump')
  writeFileSync(backupPath, Buffer.from('PGDMP\0fixture'))
  const attestation = signed({ schema_version: '2', kind: 'postgres_backup',
    environment: 'production', simulated: false, backup_file_name: 'before-upgrade-254.dump',
    backup_sha256: sha(Buffer.from('PGDMP\0fixture')), source_database_id_sha256: h('3'),
    source_database_oid: 16384, source_database_name: 'merchant', migration_version: 254,
    snapshot_id_sha256: h('4'), backup_started_at: '2026-09-28T04:00:00.000Z',
    snapshot_export_observed_at: '2026-09-28T04:00:01.000Z',
    dump_completed_at: '2026-09-28T04:00:02.000Z', created_at: '2026-09-28T04:00:00.000Z',
    expires_at: '2026-09-28T05:00:02.000Z', key_id: 'production-evidence' })
  const manifest = signed({ schema_version: 'demo-254-protected-backup-capture/1',
    environment: 'production', simulated: false, backup_file_name: attestation.backup_file_name,
    backup_sha256: attestation.backup_sha256, attestation_sha256: sha(JSON.stringify(attestation)),
    snapshot_id_sha256: attestation.snapshot_id_sha256,
    source_database_id_sha256: attestation.source_database_id_sha256,
    migration_version: 254, migration_history_sha256: plan.database.prefix_254_sha256,
    frozen_source_sha256: h('5'), fresh_observation_sha256: h('6'),
    signed_plan_sha256: sha(canonical(signedSourcePlan)), key_id: 'production-evidence' })
  const restore = signed({ schema_version: 'ecs-bridge-255-pg17-restore/1', status: 'pass',
    simulated: false, attempt_id: plan.attempt_id, plan_sha256: validateBridge255Plan(plan),
    backup_sha256: attestation.backup_sha256,
    source_database_id_sha256: attestation.source_database_id_sha256,
    source_prefix_254_sha256: plan.database.prefix_254_sha256,
    migrated_prefix_255_sha256: plan.database.prefix_255_sha256,
    restored_prefix_version: 254, migrated_version: 255,
    postgres_image_ref: plan.pg17_image_ref, postgres_image_id: `sha256:${h('7')}`,
    container_id: h('a'),
    network_id: h('8'), network_internal: true, published_ports: [],
    volume_name: 'merchant_restore_data_abcdefghijkl', target_database_id_sha256: h('9'),
    migration_255_sql_sha256: h('a'),
    recovery_image_set_digest: plan.recovery_255.identity.image_set_digest,
    captured_at: '2026-09-28T04:01:00.000Z', expires_at: '2026-09-28T05:01:00.000Z',
    key_id: 'production-evidence' })
  return { plan, signedSourcePlan, manifest, attestation, restore, backupPath,
    publicPem, keyId: 'production-evidence', now }
}

test('exact signed 254 source, backup bytes and isolated 254→255 restore handoff remains review-only', () => {
  const result = reviewBridge255HostHandoff(fixture())
  assert.equal(result.status, 'review_only')
  assert.equal(result.migration_authorized, false)
  assert.equal(result.production_cutover_authorized, false)
})

test('rejects old 242 attestation, wrong source and tampered dump', () => {
  for (const mutate of [
    f => { f.attestation.migration_version = 242 },
    f => { f.signedSourcePlan.freeze.postgres.compose_project = 'merchant-production' },
    f => { writeFileSync(f.backupPath, 'changed dump') },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => reviewBridge255HostHandoff(f), /BRIDGE_255_HOST_|DEMO_254_CAPTURE_/u)
  }
})

test('rejects expired, fake, exposed, cross-attempt and wrong-prefix restore proof', () => {
  for (const mutate of [
    f => { f.restore.signature_base64 = f.restore.signature_base64.replace(/^./u, 'A') },
    f => { f.restore.published_ports = [5432]; f.restore = signed({ ...f.restore, signature_base64: undefined }) },
    f => { f.restore.attempt_id = 'attempt_other_abcdefghijkl'; f.restore = signed({ ...f.restore, signature_base64: undefined }) },
    f => { f.restore.source_prefix_254_sha256 = h('a'); f.restore = signed({ ...f.restore, signature_base64: undefined }) },
    f => { f.restore.expires_at = '2026-09-28T04:01:30.000Z'; f.restore = signed({ ...f.restore, signature_base64: undefined }) },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => reviewBridge255HostHandoff(f), /BRIDGE_255_HOST_/u)
  }
})

function restoreFixture() {
  const f = fixture()
  const sql = Buffer.from('CREATE TABLE isolated_255_fixture (id bigint);')
  const expectedRows = Array.from({ length: 255 }, (_, index) => ({
    version: index + 1, name: index === 254 ? 'scoped_brand_settings' : `migration_${index + 1}`,
    checksum: index === 254 ? sha(sql) : sha(`sql-${index + 1}`),
  }))
  const historyHash = rows => sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))
  f.plan.database.prefix_254_sha256 = historyHash(expectedRows.slice(0, 254))
  f.plan.database.prefix_255_sha256 = historyHash(expectedRows)
  f.signedSourcePlan.freeze.database.history_sha256 = f.plan.database.prefix_254_sha256
  f.signedSourcePlan.freeze.candidate_migrations = expectedRows.slice(0, 254)
  f.signedSourcePlan = signed({ freeze: f.signedSourcePlan.freeze, key_id: f.keyId })
  f.manifest.migration_history_sha256 = f.plan.database.prefix_254_sha256
  f.manifest.signed_plan_sha256 = sha(canonical(f.signedSourcePlan))
  f.manifest = signed({ ...f.manifest, signature_base64: undefined })
  const events = []
  const state = { version: 0, exposed: false, failSql: false, quarantined: false }
  const inspection = () => ({ container_id: h('a'), database_id_sha256: h('9'),
    image_id: f.plan.pg17_image_ref, network_id: h('8'), network_internal: true,
    published_ports: state.exposed ? [5432] : [],
    volume_name: 'merchant_restore_data_abcdefghijkl', volume_preserved: true,
    source_mounted: false })
  const isolation = {
    async create(options) { events.push('create'); assert.equal(options.publishPorts, false) },
    async inspect() { events.push('inspect'); return inspection() },
    async restoreDump() { events.push('restore'); state.version = 254 },
    async readHistory() { events.push(`read:${state.version}`); return expectedRows.slice(0, state.version) },
    async applyOnly255(options) {
      events.push('sql255')
      assert.equal(options.sqlSha256, sha(sql))
      if (state.failSql) throw new Error('offline SQL failure')
      state.version = 255
    },
    async quarantineAttempt(options) { events.push('quarantine'); state.quarantined = true
      assert.equal(options.preserveVolume, true) },
  }
  return { f, expectedRows, migration255: { version: 255, name: expectedRows[254].name, sql },
    isolation, events, state }
}

test('isolated PG17 restore checks exact 254 and 255 histories before signing proof', async () => {
  const { f, expectedRows, migration255, isolation, events, state } = restoreFixture()
  const result = await produceBridge255Pg17Restore({ ...f, expectedRows, migration255,
    privatePem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    now: () => now }, isolation)
  assert.equal(result.status, 'isolated_restore_signed')
  assert.equal(result.production_authorized, false)
  assert.equal(result.restore.migrated_prefix_255_sha256, f.plan.database.prefix_255_sha256)
  assert.equal(state.quarantined, false)
  assert.deepEqual(events.filter(x => x === 'restore' || x === 'sql255' || x.startsWith('read:')),
    ['restore', 'read:254', 'sql255', 'read:255'])
})

test('bad signed source or frozen 255 SQL refuses all isolated operations', async () => {
  for (const mutate of [
    x => { x.f.attestation.migration_version = 242 },
    x => { x.migration255.sql = Buffer.from('ALTER TABLE changed ADD COLUMN unsafe int') },
    x => { x.expectedRows[0].checksum = h('f') },
  ]) {
    const x = restoreFixture(); mutate(x)
    await assert.rejects(produceBridge255Pg17Restore({ ...x.f, expectedRows: x.expectedRows,
      migration255: x.migration255,
      privatePem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      now: () => now }, x.isolation))
    assert.deepEqual(x.events, [])
  }
})

test('lost isolation or SQL failure quarantines attempt and preserves its volume', async () => {
  for (const failure of ['exposed', 'failSql']) {
    const x = restoreFixture(); x.state[failure] = true
    await assert.rejects(produceBridge255Pg17Restore({ ...x.f, expectedRows: x.expectedRows,
      migration255: x.migration255,
      privatePem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      now: () => now }, x.isolation))
    assert.equal(x.state.quarantined, true)
    assert.equal(x.events.at(-1), 'quarantine')
    if (failure === 'exposed') assert.equal(x.events.includes('restore'), false)
  }
})

test('signed isolated preview plan binds current 254 source without claiming a live bridge', async () => {
  const x = restoreFixture()
  const privatePem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const plan = createSignedBridge255PreviewPlan({ attemptId: x.f.plan.attempt_id,
    signedSourcePlan: x.f.signedSourcePlan, manifest: x.f.manifest,
    attestation: x.f.attestation, backupPath: x.f.backupPath,
    migration255Sql: x.migration255.sql, pg17ImageId: x.f.plan.pg17_image_ref,
    publicPem, privatePem, keyId: x.f.keyId, now })
  assert.equal(plan.source_release_id, x.f.signedSourcePlan.freeze.public_route.release_id)
  assert.equal(plan.production_deploy_authorized, false)
  const result = await runSignedBridge255Preview({ plan,
    signedSourcePlan: x.f.signedSourcePlan, manifest: x.f.manifest,
    attestation: x.f.attestation, backupPath: x.f.backupPath,
    migration255Sql: x.migration255.sql, publicPem, privatePem,
    keyId: x.f.keyId, now: () => now }, x.isolation)
  assert.equal(result.status, 'pass')
  assert.equal(result.production_deploy_authorized, false)
  assert.equal(x.state.version, 255)
  assert.deepEqual(x.events.filter(event => event === 'restore' || event === 'sql255'),
    ['restore', 'sql255'])
})

test('isolated preview rejects changed source, SQL, signature and expiration before Docker', async () => {
  for (const mutate of [
    x => { x.plan.production_deploy_authorized = true },
    x => { x.plan.signature_base64 = 'bad' },
    x => { x.sql = Buffer.from('DROP TABLE unsafe') },
    x => { x.plan.expires_at = '2026-09-28T04:01:00.000Z' },
  ]) {
    const x = restoreFixture()
    const privatePem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    x.plan = createSignedBridge255PreviewPlan({ attemptId: x.f.plan.attempt_id,
      signedSourcePlan: x.f.signedSourcePlan, manifest: x.f.manifest,
      attestation: x.f.attestation, backupPath: x.f.backupPath,
      migration255Sql: x.migration255.sql, pg17ImageId: x.f.plan.pg17_image_ref,
      publicPem, privatePem, keyId: x.f.keyId, now })
    x.sql = x.migration255.sql
    mutate(x)
    await assert.rejects(runSignedBridge255Preview({ plan: x.plan,
      signedSourcePlan: x.f.signedSourcePlan, manifest: x.f.manifest,
      attestation: x.f.attestation, backupPath: x.f.backupPath,
      migration255Sql: x.sql, publicPem, privatePem,
      keyId: x.f.keyId, now: () => now }, x.isolation))
    assert.deepEqual(x.events, [])
  }
})
