import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, name: string) {
  const result = new URL(base)
  result.pathname = `/${name}`
  return result.toString()
}

async function seedContextAndUsage(pool: Pool, workspaceId: string, suffix: string) {
  const contextHash = 'a'.repeat(64)
  await pool.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [workspaceId])
  await pool.query(`INSERT INTO brands (workspace_id,id,name) VALUES ($1,$2,$3)`, [workspaceId, `brand_${suffix}`, `Release ${suffix}`])
  await pool.query(`INSERT INTO context_blobs (workspace_id,context_hash,envelope,input_tokens_estimate,max_input_tokens)
    VALUES ($1,$2,'{}'::jsonb,1,100)`, [workspaceId, contextHash])
  await pool.query(`INSERT INTO context_snapshot_links (id,workspace_id,context_hash,brand_id,versions)
    VALUES ($1,$2,$3,$4,'{}'::jsonb)`, [`link_${suffix}`, workspaceId, contextHash, `brand_${suffix}`])
  await pool.query(`INSERT INTO action_ledger (id,workspace_id,action_key,action_kind,settlement,state,units,amount_fen,actor_id,description)
    VALUES ($1,$2,$3,'model_text','wallet','settled',1,0,'release-test','074 release')`, [`action_${suffix}`, workspaceId, `action_${suffix}`])
  await pool.query(`INSERT INTO model_usage_ledger
    (id,workspace_id,receipt_key,receipt_hash,settlement_status,action_id,modality,model,input_tokens,output_tokens,total_tokens,metadata)
    VALUES ($1,$2,$3,$4,'settled',$5,'text','release-model',1,1,2,$6::jsonb)`, [
    `usage_${suffix}`, workspaceId, `receipt_${suffix}`, 'b'.repeat(64), `action_${suffix}`,
    JSON.stringify({ context_link_id: `link_${suffix}`, context_hash: contextHash }),
  ])
}

describe('persistence migration 074 PostgreSQL release acceptance', () => {
  postgresIt('supports fresh/073 upgrade, metadata backfill, idempotency, RLS, and orphan-proof foreign keys', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const freshName = `release_074_fresh_${suffix}`
    const upgradeName = `release_074_upgrade_${suffix}`
    const admin = new Pool({ connectionString: base.toString() })
    let fresh: Pool | undefined
    let upgrade: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${freshName}"`)
      await admin.query(`CREATE DATABASE "${upgradeName}"`)
      fresh = new Pool({ connectionString: databaseUrl(base, freshName) })
      upgrade = new Pool({ connectionString: databaseUrl(base, upgradeName) })
      const migrations = await loadMigrations()
      const through73 = migrations.filter(item => item.version <= 73)
      const through74 = migrations.filter(item => item.version <= 74)

      expect(await new MigrationRunner(fresh, through74).run()).toEqual(through74.map(item => item.version))
      expect(await new MigrationRunner(fresh, through74).run()).toEqual([])
      expect(await fresh.query(`SELECT count(*)::int AS count, min(version)::int AS min, max(version)::int AS max FROM schema_migrations`)).toMatchObject({ rows: [{ count: 74, min: 1, max: 74 }] })
      expect(await fresh.query(`SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname IN ('model_usage_ledger','context_snapshot_links') ORDER BY relname`)).toMatchObject({
        rows: [
          { relname: 'context_snapshot_links', relrowsecurity: true, relforcerowsecurity: true },
          { relname: 'model_usage_ledger', relrowsecurity: true, relforcerowsecurity: true },
        ],
      })

      expect(await new MigrationRunner(upgrade, through73).run()).toEqual(through73.map(item => item.version))
      await seedContextAndUsage(upgrade, 'ws_074_upgrade', suffix)
      expect(await new MigrationRunner(upgrade, migrations.filter(item => item.version === 74)).run()).toEqual([74])
      expect(await new MigrationRunner(upgrade, through74).run()).toEqual([])
      expect(await upgrade.query(`SELECT count(*)::int AS count, min(version)::int AS min, max(version)::int AS max FROM schema_migrations`)).toMatchObject({ rows: [{ count: 74, min: 1, max: 74 }] })

      const linked = await upgrade.query(`SELECT usage.context_link_id, usage.context_hash, action.context_link_id AS action_link_id, action.context_hash AS action_hash
        FROM model_usage_ledger usage JOIN action_ledger action ON action.workspace_id=usage.workspace_id AND action.action_key=usage.action_id
        WHERE usage.id=$1`, [`usage_${suffix}`])
      expect(linked.rows).toEqual([{ context_link_id: `link_${suffix}`, context_hash: 'a'.repeat(64), action_link_id: `link_${suffix}`, action_hash: 'a'.repeat(64) }])

      await expect(upgrade.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,settlement_status,action_id,modality,model,context_link_id,context_hash)
        VALUES ('usage_bad_pair','ws_074_upgrade','receipt_bad_pair',repeat('c',64),'settled',NULL,'text','release-model','link_${suffix}',NULL)`)).rejects.toMatchObject({ code: '23514' })
      await expect(upgrade.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,settlement_status,action_id,modality,model,context_link_id,context_hash)
        VALUES ('usage_bad_context','ws_074_upgrade','receipt_bad_context',repeat('d',64),'settled',NULL,'text','release-model','missing_link','${'b'.repeat(64)}')`)).rejects.toMatchObject({ code: '23503' })
      await expect(upgrade.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,settlement_status,action_id,modality,model,context_link_id,context_hash)
        VALUES ('usage_bad_action','ws_074_upgrade','receipt_bad_action',repeat('e',64),'settled','missing_action','text','release-model',NULL,NULL)`)).rejects.toMatchObject({ code: '23503' })
    } finally {
      await Promise.all([fresh?.end(), upgrade?.end()])
      for (const name of [freshName, upgradeName]) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name])
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      }
      await admin.end()
    }
  }, 240_000)
})
