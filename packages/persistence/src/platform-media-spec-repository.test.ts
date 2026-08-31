import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { computePlatformMediaSpecImmutableDigest as computeDigestFromIndex } from './index.js'
import {
  computePlatformMediaSpecImmutableDigest,
  MemoryPlatformMediaSpecRepository,
  PLATFORM_MEDIA_SPEC_PLATFORMS,
  PlatformMediaSpecRepositoryError,
  PostgresPlatformMediaSpecRepository,
  type CreatePlatformMediaSpecInput,
  type PlatformMediaSpecRepository,
} from './platform-media-spec-repository.js'

const DAY = 86_400_000
const start = Date.parse('2030-01-01T00:00:00.000Z')
const at = (days: number) => new Date(start + days * DAY).toISOString()
const digest = (character: string) => character.repeat(64)
const ops = { actorId: 'ops_media_1', actorRole: 'merchant_ops' as const }

function draft(overrides: Partial<CreatePlatformMediaSpecInput> = {}): CreatePlatformMediaSpecInput {
  return {
    id: randomUUID(),
    platform: 'taobao',
    placement: 'product-detail-hero',
    device: 'mobile',
    version: '2029.12',
    specJson: { width: 800, height: 800, safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, formats: ['image/webp', 'image/jpeg'], maxFileBytes: 2_000_000 },
    sourceUrl: 'https://platform.example/media-specs/hero',
    sourceSha256: digest('a'),
    checkedAt: at(-1),
    evidenceArtifactRef: 'artifact://platform-specs/taobao/hero/2029.12',
    evidenceArtifactSha256: digest('b'),
    expiresAt: at(30),
    reason: 'verified against immutable platform evidence',
    idempotencyKey: randomUUID(),
    ...ops,
    ...overrides,
  }
}

async function approve(repository: PlatformMediaSpecRepository, input: CreatePlatformMediaSpecInput) {
  const created = await repository.createDraft(input)
  return repository.approve({ id: created.spec.id, expectedRevision: created.spec.revision, reason: 'platform operations approval', idempotencyKey: randomUUID(), ...ops })
}

describe('MemoryPlatformMediaSpecRepository', () => {
  it('computes immutable digests through both the repository module and public index export', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    const created = await repository.createDraft(draft({ idempotencyKey: 'digest-export-contract' }))

    expect(created.spec.immutableDigest).toBe(computePlatformMediaSpecImmutableDigest(created.spec))
    expect(computeDigestFromIndex(created.spec)).toBe(created.spec.immutableDigest)
    expect(computeDigestFromIndex({ ...created.spec, version: 'changed' })).not.toBe(created.spec.immutableDigest)
  })

  it('supports exactly the six governed platforms with stable immutable evidence digests', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    for (const [index, platform] of PLATFORM_MEDIA_SPEC_PLATFORMS.entries()) {
      const result = await repository.createDraft(draft({ platform, placement: `hero-${index}`, version: `v${index}`, idempotencyKey: `create-${platform}` }))
      expect(result.spec).toMatchObject({ platform, status: 'draft', revision: 1 })
      expect(result.spec.immutableDigest).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(await repository.list()).toHaveLength(6)
    await expect(repository.createDraft(draft({ platform: 'instagram' as never }))).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_INVALID' })
  })

  it('denies workspace callers and requires immutable SHA256 evidence for approval', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    await expect(repository.createDraft(draft({ actorRole: 'workspace' }))).rejects.toBeInstanceOf(PlatformMediaSpecRepositoryError)
    const created = await repository.createDraft(draft({ evidenceArtifactRef: undefined, evidenceArtifactSha256: undefined }))
    await expect(repository.approve({ id: created.spec.id, expectedRevision: 1, reason: 'invalid approval', idempotencyKey: randomUUID(), ...ops })).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_APPROVAL_EVIDENCE_REQUIRED' })
  })

  it('enforces idempotency, optimistic locking, and immutable approved records', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    const input = draft({ id: undefined, idempotencyKey: 'stable-create' })
    const first = await repository.createDraft(input)
    await expect(repository.createDraft(input)).resolves.toEqual({ spec: first.spec, replayed: true })
    await expect(repository.createDraft({ ...input, version: 'changed' })).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT' })
    await expect(repository.updateDraft({ id: first.spec.id, expectedRevision: 99, patch: { version: 'v2' }, reason: 'stale update', idempotencyKey: 'stale', ...ops })).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_REVISION_CONFLICT' })
    const approved = await repository.approve({ id: first.spec.id, expectedRevision: 1, reason: 'approve', idempotencyKey: 'approve', ...ops })
    await expect(repository.updateDraft({ id: approved.spec.id, expectedRevision: 2, patch: { specJson: { width: 1 } }, reason: 'mutate', idempotencyKey: 'mutate', ...ops })).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_TRANSITION_INVALID' })
    expect((await repository.listAudit(first.spec.id)).map(event => event.eventType)).toEqual(['created', 'approved'])
  })

  it('allows only one approved record per platform/placement/device', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    await approve(repository, draft({ version: 'v1' }))
    const second = await repository.createDraft(draft({ version: 'v2' }))
    await expect(repository.approve({ id: second.spec.id, expectedRevision: 1, reason: 'conflict', idempotencyKey: randomUUID(), ...ops })).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_ACTIVE_CONFLICT' })
  })

  it('expires at the exact boundary, records system audit, and permits a successor', async () => {
    let now = at(0)
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(now))
    const first = await approve(repository, draft({ version: 'v1', expiresAt: at(1) }))
    expect(await repository.resolveActive({ platform: 'taobao', placement: 'product-detail-hero', device: 'mobile', at: at(0.999) })).toMatchObject({ id: first.spec.id })
    now = at(1)
    await expect(repository.resolveActive({ platform: 'taobao', placement: 'product-detail-hero', device: 'mobile' })).resolves.toBeUndefined()
    await expect(repository.get(first.spec.id)).resolves.toMatchObject({ status: 'expired', revision: 3, updatedBy: 'system' })
    expect((await repository.listAudit(first.spec.id)).at(-1)).toMatchObject({ eventType: 'auto_expired', actorRole: 'system' })
    await expect(approve(repository, draft({ version: 'v2', checkedAt: at(0), expiresAt: at(2) }))).resolves.toMatchObject({ spec: { status: 'approved' } })
  })

  it('rejects expired evidence, credential-bearing source URLs and malformed hashes fail-safe', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    for (const input of [
      draft({ sourceSha256: 'not-a-hash' }),
      draft({ sourceUrl: 'https://secret:token@platform.example/spec' }),
      draft({ sourceUrl: 'http://platform.example/spec' }),
      draft({ evidenceArtifactSha256: digest('z') }),
      draft({ checkedAt: at(1) }),
    ]) await expect(repository.createDraft(input)).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_INVALID' })
    const expired = await repository.createDraft(draft({ expiresAt: at(0) }))
    await expect(repository.approve({ id: expired.spec.id, expectedRevision: 1, reason: 'too late', idempotencyKey: randomUUID(), ...ops })).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_APPROVAL_EVIDENCE_REQUIRED' })
  })

  it('normalizes NFKC scopes and rejects controls or unsafe JSON fail-safe', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    const normalized = await repository.createDraft(draft({ placement: 'ｈｅｒｏ', version: 'ｖ１' }))
    expect(normalized.spec).toMatchObject({ placement: 'hero', version: 'v1' })
    await expect(repository.createDraft(draft({ placement: 'hero', version: 'v1' }))).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT' })
    await expect(repository.createDraft(draft({ placement: 'hero\u200b' }))).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_INVALID' })
    const circular: Record<string, unknown> = {}; circular.self = circular
    let deep: Record<string, unknown> = { leaf: true }; for (let index = 0; index < 12; index += 1) deep = { nested: deep }
    for (const specJson of [{ invalid: Number.NaN }, { invalid: Number.POSITIVE_INFINITY }, { invalid: undefined }, { invalid: 1n }, circular, deep, { huge: 'x'.repeat(50_000) }]) {
      await expect(repository.createDraft(draft({ specJson: specJson as Record<string, unknown> }))).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_INVALID' })
    }
  })

  it('keeps one idempotency namespace stable across all records and operations', async () => {
    const repository = new MemoryPlatformMediaSpecRepository(() => new Date(at(0)))
    const first = await repository.createDraft(draft({ idempotencyKey: 'global-intent' }))
    await expect(repository.createDraft(draft({ placement: 'other', version: 'other', idempotencyKey: 'global-intent' }))).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT' })
    await expect(repository.approve({ id: first.spec.id, expectedRevision: 1, reason: 'cross-operation reuse', idempotencyKey: 'global-intent', ...ops })).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT' })
    await expect(repository.createDraft(draft({ idempotencyKey: 'auto-expire:reserved' }))).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_SPEC_INVALID' })
  })
})

const postgresIt = process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL ? it : it.skip

describe('PostgresPlatformMediaSpecRepository integration', () => {
  postgresIt('matches memory semantics and enforces database immutability and least privilege', async () => {
    const adminUrl = new URL(process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL!)
    const databaseName = `platform_media_${randomUUID().replaceAll('-', '')}`
    const publicProbeRole = `platform_media_public_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      await admin.query(`CREATE ROLE "${publicProbeRole}" NOLOGIN`)
      const databaseUrl = new URL(adminUrl)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString(), max: 4 })
      await new MigrationRunner(database, await loadMigrations()).run()
      const repository = new PostgresPlatformMediaSpecRepository(database, () => new Date(at(0)))
      const input = draft({ id: randomUUID(), idempotencyKey: 'pg-create' })
      const created = await repository.createDraft(input)
      await expect(repository.createDraft(input)).resolves.toEqual({ spec: created.spec, replayed: true })
      const approved = await repository.approve({ id: created.spec.id, expectedRevision: 1, reason: 'approved in real postgres', idempotencyKey: 'pg-approve', ...ops })
      await expect(repository.resolveActive({ platform: input.platform, placement: input.placement, device: input.device })).resolves.toMatchObject({ id: approved.spec.id, status: 'approved' })
      await expect(database.query('UPDATE platform_media_specs SET spec_json=$2 WHERE id=$1', [approved.spec.id, { width: 1 }])).rejects.toThrow(/immutable/u)
      await expect(database.query('UPDATE platform_media_specs SET evidence_artifact_sha256=$2 WHERE id=$1', [approved.spec.id, digest('c')])).rejects.toThrow(/immutable/u)
      const audit = await repository.listAudit(approved.spec.id)
      expect(audit.map(event => event.eventType)).toEqual(['created', 'approved'])
      expect(await database.query("SELECT has_table_privilege('merchant_app','platform_media_specs','SELECT') AS app_spec_select, has_table_privilege('merchant_app','platform_media_specs','INSERT') AS app_spec_insert, has_table_privilege('merchant_app','platform_media_spec_audit','SELECT') AS app_audit_select, has_table_privilege('merchant_app','active_platform_media_specs','SELECT') AS app_active_select, has_table_privilege('merchant_ops','platform_media_specs','DELETE') AS ops_delete, has_table_privilege('merchant_ops','platform_media_spec_audit','UPDATE') AS ops_audit_update, has_table_privilege('merchant_ops','active_platform_media_specs','SELECT') AS ops_view_select")).toMatchObject({ rows: [{ app_spec_select: false, app_spec_insert: false, app_audit_select: false, app_active_select: true, ops_delete: false, ops_audit_update: false, ops_view_select: false }] })
      expect((await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='active_platform_media_specs' ORDER BY ordinal_position")).rows.map(row => row.column_name)).toEqual(['id', 'platform', 'placement', 'device', 'version', 'spec_json', 'immutable_digest', 'checked_at', 'expires_at', 'revision'])
      const appClient = await database.connect()
      try {
        await appClient.query('BEGIN')
        await appClient.query('SET LOCAL ROLE merchant_app')
        await expect(appClient.query('SELECT id FROM platform_media_specs')).rejects.toThrow(/permission denied/u)
        await appClient.query('ROLLBACK')
        await appClient.query('BEGIN')
        await appClient.query('SET LOCAL ROLE merchant_app')
        await expect(appClient.query('SELECT id FROM active_platform_media_specs')).resolves.toMatchObject({ rows: [{ id: approved.spec.id }] })
        await expect(appClient.query("INSERT INTO platform_media_specs (id,platform,placement,device,version,spec_json,source_url,source_sha256,checked_at,immutable_digest,created_by,updated_by) VALUES (gen_random_uuid(),'jd','hero','mobile','evil','{}','https://example.test',repeat('a',64),now(),repeat('b',64),'workspace','workspace')")).rejects.toThrow(/permission denied/u)
        await appClient.query('ROLLBACK')
      } finally {
        appClient.release()
      }

      const publicClient = await database.connect()
      try {
        await publicClient.query('BEGIN')
        await publicClient.query(`SET LOCAL ROLE "${publicProbeRole}"`)
        await expect(publicClient.query('SELECT id FROM active_platform_media_specs')).rejects.toThrow(/permission denied/u)
        await publicClient.query('ROLLBACK')
      } finally { publicClient.release() }

      const directInput = draft({ placement: 'ｈｅｒｏ', version: 'direct-nfkc' })
      await expect(database.query("INSERT INTO platform_media_specs (id,platform,placement,device,version,spec_json,source_url,source_sha256,checked_at,immutable_digest,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$12)", [directInput.id, directInput.platform, directInput.placement, directInput.device, directInput.version, directInput.specJson, directInput.sourceUrl, directInput.sourceSha256, directInput.checkedAt, digest('d'), ops.actorId, at(0)])).rejects.toThrow()
      const controlInput = draft({ placement: 'hero\u200b', version: 'direct-control' })
      await expect(database.query("INSERT INTO platform_media_specs (id,platform,placement,device,version,spec_json,source_url,source_sha256,checked_at,immutable_digest,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$12)", [controlInput.id, controlInput.platform, controlInput.placement, controlInput.device, controlInput.version, controlInput.specJson, controlInput.sourceUrl, controlInput.sourceSha256, controlInput.checkedAt, digest('d'), ops.actorId, at(0)])).rejects.toThrow()
      const httpInput = draft({ sourceUrl: 'http://platform.example/insecure' })
      await expect(database.query("INSERT INTO platform_media_specs (id,platform,placement,device,version,spec_json,source_url,source_sha256,checked_at,immutable_digest,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$12)", [httpInput.id, httpInput.platform, 'http-proof', httpInput.device, 'http-proof', httpInput.specJson, httpInput.sourceUrl, httpInput.sourceSha256, httpInput.checkedAt, digest('d'), ops.actorId, at(0)])).rejects.toThrow()
      let databaseDeepJson: Record<string, unknown> = { leaf: true }; for (let index = 0; index < 12; index += 1) databaseDeepJson = { nested: databaseDeepJson }
      const deepInput = draft({ specJson: databaseDeepJson })
      await expect(database.query("INSERT INTO platform_media_specs (id,platform,placement,device,version,spec_json,source_url,source_sha256,checked_at,immutable_digest,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$12)", [deepInput.id, deepInput.platform, 'deep-json', deepInput.device, 'deep-json', deepInput.specJson, deepInput.sourceUrl, deepInput.sourceSha256, deepInput.checkedAt, digest('d'), ops.actorId, at(0)])).rejects.toThrow()

      const contenderA = await repository.createDraft(draft({ platform: 'jd', placement: 'concurrent-hero', version: 'v1', idempotencyKey: 'pg-concurrent-create-a' }))
      const contenderB = await repository.createDraft(draft({ platform: 'jd', placement: 'concurrent-hero', version: 'v2', idempotencyKey: 'pg-concurrent-create-b' }))
      const activations = await Promise.allSettled([
        repository.approve({ id: contenderA.spec.id, expectedRevision: 1, reason: 'concurrent approval a', idempotencyKey: 'pg-concurrent-approve-a', ...ops }),
        new PostgresPlatformMediaSpecRepository(database, () => new Date(at(0))).approve({ id: contenderB.spec.id, expectedRevision: 1, reason: 'concurrent approval b', idempotencyKey: 'pg-concurrent-approve-b', ...ops }),
      ])
      expect(activations.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(activations.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'PLATFORM_MEDIA_SPEC_ACTIVE_CONFLICT' } })
      expect(await database.query("SELECT count(*)::integer AS count FROM platform_media_specs WHERE platform='jd' AND placement='concurrent-hero' AND device='mobile' AND status='approved'")).toMatchObject({ rows: [{ count: 1 }] })
      const globalIntent = await Promise.allSettled([
        repository.createDraft(draft({ platform: 'douyin', placement: 'intent-a', version: 'v1', idempotencyKey: 'pg-global-intent' })),
        new PostgresPlatformMediaSpecRepository(database, () => new Date(at(0))).createDraft(draft({ platform: 'douyin', placement: 'intent-b', version: 'v1', idempotencyKey: 'pg-global-intent' })),
      ])
      expect(globalIntent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(globalIntent.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT' } })
      const stableIntentInput = draft({ id: undefined, platform: 'xiaohongshu', placement: 'stable-intent', version: 'v1', idempotencyKey: 'pg-stable-intent' })
      const stableIntent = await Promise.all([
        repository.createDraft(stableIntentInput),
        new PostgresPlatformMediaSpecRepository(database, () => new Date(at(0))).createDraft(stableIntentInput),
      ])
      expect(new Set(stableIntent.map(result => result.spec.id)).size).toBe(1)
      expect(stableIntent.map(result => result.replayed).sort()).toEqual([false, true])
      expect((await database.query('SELECT immutable_digest FROM platform_media_specs WHERE id=$1', [approved.spec.id])).rows[0]?.immutable_digest).toBe(approved.spec.immutableDigest)
      await expect(repository.resolveActive({ platform: input.platform, placement: input.placement, device: input.device, at: at(30) })).resolves.toBeUndefined()
      await expect(repository.get(approved.spec.id, at(30))).resolves.toMatchObject({ status: 'expired', updatedBy: 'system' })
      await expect(database.query('SELECT id FROM active_platform_media_specs WHERE id=$1', [approved.spec.id])).resolves.toMatchObject({ rows: [] })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.query(`DROP ROLE IF EXISTS "${publicProbeRole}"`)
      await admin.end()
    }
  }, 120_000)
})
