import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeDigestArgument, migrationContainerArgs, postgresContainerArgs, readArchiveCommit, retainedNonceBinding, validateArchiveCommit, validateContainerInspection, validateMigrationAssets, validateRestoreInputs } from '../infra/protected/restore-pg17-isolated.mjs'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const names = ['clamav', 'merchant-api', 'merchant-ops-ui', 'merchant-ui', 'merchant-worker', 'payment-gateway', 'pilot-gateway', 'postgres-migration']
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const releaseId = 'release-restore-1', gitSha = 'a'.repeat(40), sourceSha = `sha256:${'b'.repeat(64)}`
  const digests = Object.fromEntries(names.map((name, index) => [name, `sha256:${String(index + 1).repeat(64)}`]))
  const references = Object.fromEntries(names.map(name => [name, name === 'postgres-migration' ? `registry.example/library/postgres:17-alpine@${digests[name]}` : `registry.example/${name}@${digests[name]}`]))
  const imageSetDigest = `sha256:${sha(names.map(name => `${name}=${digests[name]}\n`).join(''))}`
  const backupSha256 = sha('real backup bytes')
  const started = new Date(Date.now() - 60_000).toISOString(), observed = new Date(Date.now() - 55_000).toISOString(), completed = new Date(Date.now() - 50_000).toISOString()
  const attestation: Record<string, unknown> = { schema_version: '2', kind: 'postgres_backup', environment: 'production', simulated: false, backup_file_name: 'before-upgrade-242.dump', backup_sha256: backupSha256, source_database_id_sha256: sha('source-system-id'), source_database_oid: 123, source_database_name: 'merchant', migration_version: 242, snapshot_id_sha256: sha('1:1'), backup_started_at: started, snapshot_export_observed_at: observed, dump_completed_at: completed, created_at: started, expires_at: new Date(Date.now() + 60_000).toISOString(), key_id: 'prod-test-key' }
  const resign = () => { attestation.signature_base64 = sign(null, Buffer.from(canonical(attestation)), privateKey).toString('base64') }
  resign()
  return { backupSha256, backupName: 'before-upgrade-242.dump', attestation, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId: 'prod-test-key', identity: { release_id: releaseId, git_sha: gitSha, source_sha256: sourceSha }, imageSet: { schema_version: 1, release_id: releaseId, release_git_sha: gitSha, source_sha256: sourceSha, image_digests: digests, image_references: references }, releaseId, gitSha, imageSetDigest, manifestSha256: 'c'.repeat(64), deploymentNonce: 'nonce_abcdefghijklmnopqrstuvwxyz', resign }
}

describe('protected PostgreSQL 17 isolated restore input contract', () => {
  it('accepts a signed 242 backup and exact eight-image PG17 release identity', () => {
    const { resign: _resign, ...input } = fixture()
    expect(validateRestoreInputs(input).postgresImage).toContain('postgres:17-alpine@sha256:')
  })
  it('rejects tampered, expired and wrong-version backup attestations', () => {
    const tampered = fixture(); tampered.attestation.migration_version = 241
    expect(() => validateRestoreInputs(tampered)).toThrow(/242 snapshot/)
    const forged = fixture(); forged.attestation.source_database_id_sha256 = sha('other')
    expect(() => validateRestoreInputs(forged)).toThrow(/signature/)
    const expired = fixture(); expired.attestation.expires_at = new Date(Date.now() - 1).toISOString(); expired.resign()
    expect(() => validateRestoreInputs(expired)).toThrow(/chronology or validity/)
    const wrongBytes = fixture(); wrongBytes.backupSha256 = sha('different backup')
    expect(() => validateRestoreInputs(wrongBytes)).toThrow(/242 snapshot/)
  })
  it('rejects signed v1, missing snapshot identity, reversed chronology and long validity', () => {
    const legacy = fixture(); legacy.attestation.schema_version = '1'; legacy.resign()
    expect(() => validateRestoreInputs(legacy)).toThrow(/signed v2/)
    const missingSnapshot = fixture(); delete missingSnapshot.attestation.snapshot_id_sha256; missingSnapshot.resign()
    expect(() => validateRestoreInputs(missingSnapshot)).toThrow(/snapshot_id_sha256/)
    const reversed = fixture(); reversed.attestation.snapshot_export_observed_at = new Date(Date.now() - 70_000).toISOString(); reversed.resign()
    expect(() => validateRestoreInputs(reversed)).toThrow(/chronology/)
    const createdMismatch = fixture(); createdMismatch.attestation.created_at = new Date(Date.now() - 59_000).toISOString(); createdMismatch.resign()
    expect(() => validateRestoreInputs(createdMismatch)).toThrow(/chronology/)
    const tooLong = fixture(); tooLong.attestation.expires_at = new Date(Date.now() + 48 * 60 * 60_000).toISOString(); tooLong.resign()
    expect(() => validateRestoreInputs(tooLong)).toThrow(/chronology/)
  })
  it('reads the embedded Git commit from the archive header and rejects another SHA', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pg17-archive-'))
    const archive = join(directory, 'source.tar')
    writeFileSync(archive, execFileSync('git', ['archive', '--format=tar', 'HEAD', 'package.json']))
    const embedded = readArchiveCommit(archive)
    expect(embedded).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
    expect(() => validateArchiveCommit(embedded, embedded)).not.toThrow()
    expect(() => validateArchiveCommit(embedded, 'f'.repeat(40))).toThrow(/embedded Git commit/)
  })
  it('retains only a one-way digest of the deployment nonce', () => {
    const nonce = 'nonce_abcdefghijklmnopqrstuvwxyz'
    const value = retainedNonceBinding(nonce)
    expect(value).toEqual({ deployment_nonce_sha256: sha(nonce) })
    expect(JSON.stringify(value)).not.toContain(nonce)
  })
  it('passes validated JSON text, not a sidecar path, to the real Ruby Compose gate', () => {
    const input = fixture()
    const digests = input.imageSet.image_digests as Record<string, string>
    const references = input.imageSet.image_references as Record<string, string>
    const services: Record<string, { image: string }> = {}
    const groups: Record<string, string[]> = {
      'merchant-api': ['api', 'api-replica'],
      'postgres-migration': ['migrate'],
      'merchant-worker': ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'],
      'merchant-ui': ['ui'], 'merchant-ops-ui': ['ops-ui'],
      'payment-gateway': ['payment-gateway'], 'pilot-gateway': ['pilot-gateway'], clamav: ['clamav'],
    }
    for (const [artifact, names] of Object.entries(groups)) for (const name of names) services[name] = { image: references[artifact]! }
    const directory = mkdtempSync(join(tmpdir(), 'pg17-compose-gate-'))
    const compose = join(directory, 'rendered-compose.json'), sidecar = join(directory, 'image-digests.json')
    writeFileSync(compose, JSON.stringify({ services }))
    writeFileSync(sidecar, JSON.stringify(digests))
    const gate = 'infra/scripts/validate-ecs-compose-release.rb'
    const jsonArgument = composeDigestArgument(digests, { ...digests })
    const imageResult = spawnSync('ruby', [gate, compose, jsonArgument, '--print-image-set-digest'], { encoding: 'utf8' })
    expect(imageResult.status).toBe(0)
    expect(imageResult.stdout.trim()).toBe(input.imageSetDigest)
    const manifestResult = spawnSync('ruby', [gate, compose, jsonArgument, '--print-manifest-sha256'], { encoding: 'utf8' })
    expect(manifestResult.status).toBe(0)
    expect(manifestResult.stdout.trim()).toMatch(/^[a-f0-9]{64}$/u)
    const pathInsteadOfJson = spawnSync('ruby', [gate, compose, sidecar, '--print-image-set-digest'], { encoding: 'utf8' })
    expect(pathInsteadOfJson.status).not.toBe(0)
    expect(() => composeDigestArgument({ ...digests, 'merchant-api': `sha256:${'0'.repeat(64)}` }, digests)).toThrow(/sidecar mismatch/)
  })
  it('keeps the isolated database password out of Docker arguments and published ports', () => {
    const image = `registry.example/library/postgres:17-alpine@sha256:${'a'.repeat(64)}`
    const postgres = postgresContainerArgs({ containerName: 'restore-db', network: 'internal-only', volume: 'restore-data', image })
    const migration = migrationContainerArgs({ migrationName: 'restore-migrate', containerName: 'restore-db', network: 'internal-only', migrations: '/protected/migrations', script: '/protected/apply-migrations.sh', image })
    for (const args of [postgres, migration]) {
      expect(args).not.toContain('-p')
      expect(args).not.toContain('--publish')
      expect(args.join(' ')).not.toContain('isolated-only')
      expect(args.slice(args.indexOf('--network') + 1, args.indexOf('--network') + 2)).toEqual(['internal-only'])
    }
    expect(postgres[postgres.indexOf('POSTGRES_PASSWORD') - 1]).toBe('--env')
    expect(migration[migration.indexOf('PGPASSWORD') - 1]).toBe('--env')
    expect(postgres.some(arg => arg.startsWith('POSTGRES_PASSWORD='))).toBe(false)
    expect(migration.some(arg => arg.startsWith('PGPASSWORD='))).toBe(false)
  })
  it('rejects missing or mutable image identity and release mismatch', () => {
    const missing = fixture(); delete (missing.imageSet.image_digests as Record<string, string>)['merchant-api']
    expect(() => validateRestoreInputs(missing)).toThrow(/inventory/)
    const mutable = fixture(); (mutable.imageSet.image_references as Record<string, string>)['postgres-migration'] = 'postgres:17-alpine'
    expect(() => validateRestoreInputs(mutable)).toThrow(/immutable image/)
    const wrongRelease = fixture(); wrongRelease.identity.git_sha = 'f'.repeat(40)
    expect(() => validateRestoreInputs(wrongRelease)).toThrow(/identity mismatch/)
    const wrongDigest = fixture(); wrongDigest.imageSetDigest = `sha256:${'0'.repeat(64)}`
    expect(() => validateRestoreInputs(wrongDigest)).toThrow(/digest mismatch/)
  })
  it('requires exactly the frozen 001–245 migration chain with named 243/244/245 files', () => {
    const migrationNames = readdirSync('packages/persistence/src/migrations')
    expect(() => validateMigrationAssets(migrationNames)).not.toThrow()
    expect(() => validateMigrationAssets(migrationNames.filter(name => !name.startsWith('243_')))).toThrow(/245 SQL files/)
    expect(() => validateMigrationAssets([...migrationNames.slice(0, -1), '245_arbitrary.sql'])).toThrow(/243\/244\/245 migration identity/)
    expect(() => validateMigrationAssets([...migrationNames.slice(0, -1), '../escape.sql'])).toThrow(/gap or unsafe/)
  })
  it('rejects a public port, foreign network, changed image or unexpected bind mount', () => {
    const options = { id: '1'.repeat(64), expectedImageId: `sha256:${'2'.repeat(64)}`, expectedNetwork: 'merchant_restore_net_test', expectedVolume: 'merchant_restore_data_test' }
    const valid = () => ({ Id: options.id, Image: options.expectedImageId, State: { Running: true }, HostConfig: { NetworkMode: options.expectedNetwork, PortBindings: {} }, NetworkSettings: { Networks: { [options.expectedNetwork]: {} }, Ports: { '5432/tcp': null } }, Mounts: [{ Type: 'volume', Name: options.expectedVolume }] })
    expect(() => validateContainerInspection(valid(), options)).not.toThrow()
    const publicPort = valid(); publicPort.NetworkSettings.Ports['5432/tcp'] = { HostPort: '5432' } as never
    expect(() => validateContainerInspection(publicPort, options)).toThrow(/published a port/)
    const foreignNetwork = valid(); foreignNetwork.HostConfig.NetworkMode = 'bridge'
    expect(() => validateContainerInspection(foreignNetwork, options)).toThrow(/internal network/)
    const changedImage = valid(); changedImage.Image = `sha256:${'3'.repeat(64)}`
    expect(() => validateContainerInspection(changedImage, options)).toThrow(/image identity/)
    const hostBind = valid(); hostBind.Mounts[0]!.Type = 'bind'
    expect(() => validateContainerInspection(hostBind, options)).toThrow(/unapproved volume/)
  })
})
