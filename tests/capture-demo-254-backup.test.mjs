import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureDemo254Backup, verifyDemo254CaptureManifest } from '../infra/protected/capture-demo-254-backup.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const id = ch => ch.repeat(64)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).filter(key => key !== 'signature_base64').sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const rows = Array.from({ length: 254 }, (_, index) => ({ version: index + 1, name: `migration_${index + 1}`, checksum: sha(`sql-${index + 1}`) }))
const historySha = sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
const now = new Date()
const iso = new Date(now.getTime() - 1000).toISOString()
const systemIdentifier = '7456012345678901234'

function inputs() {
  const publicRoute = { origin: 'https://yxsona.com', host: 'yxsona.com', path_prefix: '/api',
    release_id: 'release-f48c8454-dual-e2e', git_sha: 'f48c84544c519642de7c92615351007c9ac70a99', gateway_id: id('a'), api_replica_id: id('b') }
  const gateway = { id: id('a'), image_id: `sha256:${id('a')}`, route_host: 'yxsona.com', route_path_prefix: '/api', upstream_container_id: id('b'), upstream_port: 8787 }
  const apiReplica = { id: id('b'), image_id: `sha256:${id('b')}`, compose_project: 'merchant-demo-85575f9c', compose_service: 'api-replica',
    network_name: 'merchant-demo-85575f9c_default', network_id: id('c'), postgres_container_id: '6abd0fb584b3746cca5b3e73d21681a24ab3780fce0a46d385ffcebcd43c0980' }
  const postgres = { id: apiReplica.postgres_container_id, image_id: `sha256:${id('d')}`, compose_project: 'merchant-demo-85575f9c', compose_service: 'postgres',
    network_name: apiReplica.network_name, network_id: apiReplica.network_id, ipv4: '192.168.96.3', volume_name: 'merchant-demo-85575f9c_merchant-postgres' }
  const connections = { runtime: { host: 'postgres', resolved_ip: postgres.ipv4, port: 5432, database: 'merchant', user: 'merchant_app' },
    ops: { host: 'postgres', resolved_ip: postgres.ipv4, port: 5432, database: 'merchant', user: 'merchant_ops' } }
  const frozen = { schema_version: 'demo-254-backup-source-freeze/1', public_route: publicRoute, gateway, api_replica: apiReplica, postgres, connections,
    database: { name: 'merchant', oid: 16384, system_identifier_sha256: sha(systemIdentifier), server_version_num: 160015, history_sha256: historySha }, candidate_migrations: rows }
  const signedPlan = { freeze: frozen, key_id: 'production-evidence' }
  signedPlan.signature_base64 = sign(null, Buffer.from(canonical(signedPlan)), privateKey).toString('base64')
  const observed = { schema_version: 'demo-254-backup-source-observation/1', observed_at: iso,
    public_route: structuredClone(publicRoute), gateway: structuredClone(gateway), api_replica: structuredClone(apiReplica),
    postgres: structuredClone(postgres), connections: structuredClone(connections) }
  const database = { name: 'merchant', oid: 16384, system_identifier: systemIdentifier, server_version_num: 160015, migration_rows: structuredClone(rows) }
  const directory = mkdtempSync(join(tmpdir(), 'demo-254-capture-'))
  const backupPath = join(directory, 'before-upgrade-254.dump')
  let clockCalls = 0
  const options = { signedPlan, planPublicPem: publicPem, privatePem, publicPem, keyId: 'production-evidence', backupPath,
    attestationPath: `${backupPath}.attestation.json`, checksumPath: `${backupPath}.sha256`, manifestPath: `${backupPath}.capture.json`,
    clock: () => new Date(now.getTime() + (clockCalls++ === 0 ? -2000 : 0)) }
  const events = []
  const collector = {
    observeTopology: async () => { events.push('topology'); return observed },
    snapshot: async () => { events.push('snapshot'); return { systemIdentifier, databaseOid: 16384, databaseName: 'merchant', migrationVersion: 254,
      snapshot: '00000003-0000001B-1', snapshotExportObservedAt: iso, release: () => events.push('release') } },
    dump: async (snapshot, path) => { events.push(`dump:${snapshot}`); writeFileSync(path, Buffer.from('PGDMP\x00fixture')) },
    observeMigrations: async snapshot => { events.push(`history:${snapshot}`); return database },
  }
  return { options, collector, events, observed, database, signedPlan }
}

test('signed 254 plan produces same-snapshot PG16 custom dump and bound signed capture manifest', async () => {
  const { options, collector, events, signedPlan } = inputs()
  const { attestation, manifest } = await captureDemo254Backup(options, collector)
  assert.deepEqual(events, ['topology', 'snapshot', 'dump:00000003-0000001B-1', 'history:00000003-0000001B-1', 'topology', 'release'])
  assert.equal(attestation.migration_version, 254)
  assert.equal(attestation.backup_sha256, sha(readFileSync(options.backupPath)))
  assert.equal(manifest.migration_history_sha256, historySha)
  assert.equal(verifyDemo254CaptureManifest(manifest, { attestation, signedPlan, publicPem }), true)
  assert.match(readFileSync(options.backupPath, 'utf8'), /^PGDMP/u)
})

test('rejects forged plan, old 242, route drift and migration checksum drift before publishing dump', async () => {
  for (const change of [
    input => { input.signedPlan.freeze.postgres.compose_project = 'merchant-production' },
    input => { input.collector.snapshot = async () => ({ systemIdentifier, databaseOid: 16384, databaseName: 'merchant', migrationVersion: 242, snapshot: '1:1:1', snapshotExportObservedAt: iso, release() {} }) },
    input => { input.observed.gateway.upstream_container_id = id('e') },
    input => { input.database.migration_rows[253].checksum = sha('wrong') },
  ]) {
    const input = inputs(); change(input)
    await assert.rejects(captureDemo254Backup(input.options, input.collector), /PLAN_SIGNATURE_INVALID|MIGRATION_VERSION_NOT_254|DEMO_254_SOURCE_/u)
    assert.throws(() => readFileSync(input.options.backupPath), /ENOENT/u)
  }
})

test('requires all independent collector operations and keeps plan credentials out of output', async () => {
  const input = inputs()
  delete input.collector.observeMigrations
  await assert.rejects(captureDemo254Backup(input.options, input.collector), /COLLECTOR_INCOMPLETE/u)
  const other = inputs()
  other.signedPlan.freeze.connections.runtime.password = 'secret'
  other.signedPlan.signature_base64 = sign(null, Buffer.from(canonical(other.signedPlan)), privateKey).toString('base64')
  await assert.rejects(captureDemo254Backup(other.options, other.collector), /SHAPE_INVALID/u)
})

test('rejects a gateway switch during the dump', async () => {
  const input = inputs()
  let calls = 0
  input.collector.observeTopology = async () => {
    calls++
    if (calls === 2) input.observed.gateway.upstream_container_id = id('e')
    return structuredClone(input.observed)
  }
  await assert.rejects(captureDemo254Backup(input.options, input.collector), /TOPOLOGY_CHANGED_DURING_DUMP/u)
  assert.throws(() => readFileSync(input.options.backupPath), /ENOENT/u)
})
