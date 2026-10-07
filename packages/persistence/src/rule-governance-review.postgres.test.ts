import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresRuleRepository } from './rule-repository.js'

const baseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = baseUrl ? it : it.skip

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('public rule reviewer queries (real PostgreSQL)', () => {
  postgresIt('carries an Ops Markdown upload from draft review through activation into the merchant public-rule projection', async () => {
    const base = new URL(baseUrl!)
    const databaseName = `rule_upload_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let ops: Pool | undefined
    let merchant: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()
      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })
      merchant = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      const repo = new PostgresRuleRepository(merchant, ops)
      const uploadedAt = '2026-10-07T08:00:00.000Z'
      const markdown = [
        '# Store Nova｜拼多多平台规则知识库 v0.2',
        '',
        '## PDD-GEN-900｜商品描述不得承诺绝对化功效',
        '- 平台：拼多多；地区：中国大陆',
        '- 官方依据：https://www.yangkeduo.com/home/help/',
        '- 规则：不得使用未经证明的绝对化功效承诺。',
      ].join('\n')
      // Match the DTO produced by the Ops Markdown parser. Its browser/parser
      // contract is covered in RuleCenterSection tests; this test isolates the
      // real-PostgreSQL review/activation/projection boundary without importing
      // the Ops TSX bundle into the persistence NodeNext project.
      const sourceReference = 'https://www.yangkeduo.com/home/help/'
      const draft = {
        packId: 'pinduoduo-manual-pdd-gen-900',
        name: '商品描述不得承诺绝对化功效',
        version: '0.2',
        targetId: 'pinduoduo',
        sourceReference,
        reason: '运营上传平台规则草稿：拼多多平台规则.md',
        checksJson: JSON.stringify({
          platform: '拼多多', source: sourceReference, sourceReference,
          sourceDocument: '拼多多平台规则.md', sourceCard: 'PDD-GEN-900',
          content: markdown.split('\n').slice(2).join('\n'),
        }),
      }
      const checks = JSON.parse(draft.checksJson) as Record<string, unknown>
      const checksumChecks = Object.fromEntries(Object.entries(checks).sort(([left], [right]) => left.localeCompare(right)))
      const checksum = createHash('sha256').update(JSON.stringify(checksumChecks)).digest('hex')
      const created = await repo.insertPublicVersionWithAudit({
        version: {
          id: 'ops-upload-pdd-gen-900', packId: draft.packId, name: draft.name, version: draft.version,
          scope: 'platform', status: 'draft', sourceKind: 'internal', sourceReference: draft.sourceReference,
          sourceCheckedAt: uploadedAt, checksum, checks: { ...checks, __public_scope: 'platform' },
          createdBy: 'ops-author', revision: 1, targetId: draft.targetId,
        },
        audit: {
          id: 'ops-upload-pdd-gen-900-created', rulePackId: draft.packId, ruleVersionId: 'ops-upload-pdd-gen-900',
          version: draft.version, action: 'created', actorId: 'ops-author', reason: draft.reason,
          occurredAt: uploadedAt, data: { checksum },
        },
      })

      expect(created.version).toMatchObject({ status: 'draft', sourceKind: 'internal', scopeValue: 'pinduoduo', revision: 1 })
      expect((await repo.listPublicDraftsForReview({ platform: 'pinduoduo', limit: 10 })).items.map(item => item.id)).toContain(created.version.id)
      expect((await repo.listPublic('merchant-workspace', 'pinduoduo')).map(item => item.id)).not.toContain(created.version.id)

      const activated = await repo.transitionPublicStatus({
        platform: 'pinduoduo', packId: draft.packId, version: draft.version, expectedRevision: 1,
        status: 'active', actorId: 'ops-reviewer', reason: '核验来源并独立审批', occurredAt: '2026-10-07T09:00:00.000Z',
        auditData: { approval_ref: 'approval://isolated-rule-test', approved_by: 'ops-reviewer', approved_at: '2026-10-07T09:00:00.000Z' },
      })
      expect(activated).toMatchObject({ status: 'active', revision: 2, scopeValue: 'pinduoduo', createdBy: 'ops-author' })
      expect((await repo.listPublicRuleAuditForReview('pinduoduo', draft.packId, draft.version)).map(item => item.action)).toEqual(['created', 'activated'])
      expect((await repo.listPublic('merchant-workspace', 'pinduoduo')).map(item => item.id)).toContain(created.version.id)
      expect((await repo.listPublic('merchant-workspace', 'jd')).map(item => item.id)).not.toContain(created.version.id)
    } finally {
      await merchant?.end()
      await ops?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)

  postgresIt('lists only drafts with stable pagination, and reads exact version plus append-only audit through the ops pool', async () => {
    const base = new URL(baseUrl!)
    const databaseName = `rule_review_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()
      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })
      const repo = new PostgresRuleRepository(ops, ops)
      const now = new Date().toISOString()
      const rows = [
        { id: 'review-a', pack: 'pack-a', version: '1', status: 'draft' },
        { id: 'review-b', pack: 'pack-b', version: '2', status: 'draft' },
        { id: 'review-c', pack: 'pack-c', version: '3', status: 'active' },
      ]
      for (const row of rows) await ops.query(
        `INSERT INTO public_platform_rule_versions
          (id, platform, pack_id, name, version, status, source_kind, source_reference, source_checked_at, checksum, checks, created_by, created_at, updated_at)
         VALUES ($1,'pinduoduo',$2,$2,$3,$4,'internal','manual://review.md', $5, repeat('a',64), '{}'::jsonb, 'review-author', $5, $5)`,
        [row.id, row.pack, row.version, row.status, now],
      )
      await ops.query(
        `INSERT INTO public_platform_rule_audits (id, rule_version_id, platform, version, action, actor_id, reason, occurred_at, data)
         VALUES ('review-audit','review-a','pinduoduo','1','created','review-author','submitted', $1, '{}'::jsonb)`, [now],
      )
      // Audit metadata is independently stored and the schema does not enforce
      // that it matches the referenced version. Corrupt/misattributed rows
      // must not appear in that version's reviewer history.
      await ops.query(
        `INSERT INTO public_platform_rule_audits (id, rule_version_id, platform, version, action, actor_id, reason, occurred_at, data)
         VALUES ('review-audit-mismatch','review-a','taobao','999','deactivated','other-reviewer','mismatched metadata', $1, '{}'::jsonb)`, [now],
      )

      const first = await repo.listPublicDraftsForReview({ platform: 'pinduoduo', limit: 1 })
      expect(first.items.map(item => item.id)).toEqual(['review-b'])
      expect(first.nextCursor).toBeDefined()
      const second = await repo.listPublicDraftsForReview({ platform: 'pinduoduo', limit: 1, cursor: first.nextCursor })
      expect(second.items.map(item => item.id)).toEqual(['review-a'])
      expect(second.nextCursor).toBeUndefined()
      expect((await repo.listPublicDraftsForReview({ platform: 'jd', limit: 10 })).items).toEqual([])
      const exact = await repo.getPublicRuleForReview('pinduoduo', 'pack-a', '1')
      expect(exact).toMatchObject({ id: 'review-a', status: 'draft', scopeValue: 'pinduoduo', createdBy: 'review-author' })
      expect(await repo.getPublicRuleForReview('taobao', 'pack-a', '1')).toBeUndefined()
      expect(await repo.listPublicRuleAuditForReview('pinduoduo', 'pack-a', '1')).toMatchObject([{ id: 'review-audit', actorId: 'review-author', reason: 'submitted' }])
      expect(await repo.listPublicRuleAuditForReview('taobao', 'pack-a', '999')).toEqual([])
      expect((await repo.listPublic('ws_unrelated')).map(item => item.id)).toEqual(['review-c'])

      const transition = {
        platform: 'pinduoduo', packId: 'pack-a', version: '1', expectedRevision: 1,
        status: 'inactive', actorId: 'reviewer', reason: 'manual review complete', occurredAt: new Date().toISOString(),
      }
      const concurrent = await Promise.allSettled([
        repo.transitionPublicStatus(transition),
        repo.transitionPublicStatus(transition),
      ])
      expect(concurrent.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(concurrent.filter(item => item.status === 'rejected')).toHaveLength(1)
      expect(concurrent.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'PUBLIC_RULE_REVISION_CONFLICT' } })
      expect((await repo.getPublicRuleForReview('pinduoduo', 'pack-a', '1'))?.revision).toBe(2)
      expect((await repo.listPublicRuleAuditForReview('pinduoduo', 'pack-a', '1')).filter(item => item.action === 'deactivated')).toHaveLength(1)
    } finally {
      await ops?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
