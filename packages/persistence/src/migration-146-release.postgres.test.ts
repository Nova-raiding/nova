import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

describe('migration 146 commercial catalog PostgreSQL release evidence', () => {
  it('applies seeds fail-closed source facts and enforces database-owner immutability', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `catalog_146_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const sql = await readFile(new URL('./migrations/146_commercial_catalog_v2.sql', import.meta.url), 'utf8')
      await database.query(sql)

      const skuFacts = await database.query<{
        total: number
        drafts: number
        unresolved_storage: number
        private_capability: string | null
      }>(`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE v.lifecycle='draft' AND v.executable=false)::int AS drafts,
          count(*) FILTER (WHERE v.payload->'storage'->>'sourceLabel'='50g'
            AND v.payload->'storage'->'normalizedBytes'='null'::jsonb)::int AS unresolved_storage,
          max(s.required_capability) FILTER (WHERE s.code='private_validation_7d') AS private_capability
        FROM commercial_catalog_skus s
        JOIN commercial_catalog_sku_versions v ON v.sku_id=s.id
      `)
      expect(skuFacts.rows[0]).toEqual({ total: 7, drafts: 7, unresolved_storage: 3, private_capability: 'commercial.private_sku.read' })
      const pointPackKinds = await database.query<{ code: string; kind: string }>(
        "SELECT code,kind FROM commercial_catalog_skus WHERE code IN ('points_500','points_2000') ORDER BY code",
      )
      expect(pointPackKinds.rows).toEqual([
        { code: 'points_2000', kind: 'point_pack' },
        { code: 'points_500', kind: 'point_pack' },
      ])

      const executableRate = await database.query<{ total: number }>(`
        SELECT count(*)::int AS total
        FROM creative_point_rate_card_versions_v2 c
        JOIN creative_point_rate_rules_v2 r ON r.rate_card_version_id=c.id
        WHERE c.lifecycle='approved' AND c.approval_status='approved'
          AND c.executable=true AND r.executable=true
      `)
      expect(executableRate.rows[0]?.total).toBe(0)
      await expect(database.query("UPDATE commercial_catalog_sku_versions SET executable=true WHERE id='sku-version-monthly-basic-v1'"))
        .rejects.toMatchObject({ code: '55000' })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
