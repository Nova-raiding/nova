import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'

const postgresIt = process.env.LEGACY_BACKFILL_DATABASE_URL ? it : it.skip

describe('049 legacy compatibility snapshot backfill', () => {
  it('runs product, task and generation-job recovery in dependency order', async () => {
    const migrations = await loadMigrations()
    const migration = migrations.find(item => item.version === 49)
    expect(migration).toMatchObject({ name: 'legacy_snapshot_backfill' })
    expect(migrations.find(item => item.version === 12)?.sql).toContain('ALTER COLUMN remote_product_id DROP NOT NULL')
    const sql = migration?.sql ?? ''
    const product = sql.indexOf('INSERT INTO products')
    const task = sql.indexOf('INSERT INTO tasks')
    const generationJob = sql.indexOf('INSERT INTO generation_jobs')
    expect(product).toBeGreaterThanOrEqual(0)
    expect(task).toBeGreaterThan(product)
    expect(generationJob).toBeGreaterThan(task)
  })

  it('fails closed on tenant identity, parents, enums and Route B scope', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 49)?.sql ?? ''
    expect(sql).toContain("snapshot.payload->>'workspaceId' = snapshot.workspace_id")
    expect(sql).toContain("snapshot.payload->>'id' = snapshot.entity_id")
    expect(sql).toContain("account.workspace_id = snapshot.workspace_id")
    expect(sql).toContain('JOIN products product')
    expect(sql).toContain('product.workspace_id = candidate.workspace_id')
    expect(sql).toContain('canonical.brand_id = brand.id')
    expect(sql).toContain('listing.canonical_product_id = canonical.id')
    expect(sql).toContain('campaign_item.canonical_product_id = canonical.id')
    expect(sql).toContain('JOIN tasks task')
    expect(sql).toContain('content.task_id = task.id')
    expect(sql).toContain("IN ('queued', 'running', 'succeeded', 'failed')")
  })

  it('preserves original payload, nulls unsafe optional links and never overwrites rows', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 49)?.sql ?? ''
    expect(sql.match(/snapshot\.payload|candidate\.payload/g)?.length).toBeGreaterThan(10)
    expect(sql).toContain('candidate.safe_brand_id')
    expect(sql).toContain('candidate.safe_canonical_product_id')
    expect(sql).toContain('candidate.safe_listing_id')
    expect(sql).toContain('CASE WHEN candidate.safe_campaign_item_id IS NOT NULL')
    expect(sql).toContain('current_content_version_id')
    expect(sql).toContain("WHEN jsonb_typeof(snapshot.payload->'remoteId') = 'string'")
    expect(sql).toContain('ELSE NULL')
    expect(sql.match(/ON CONFLICT DO NOTHING;/g)).toHaveLength(3)
    expect(sql).not.toMatch(/DO UPDATE|DELETE FROM|TRUNCATE TABLE|DROP TABLE|DROP COLUMN/i)
  })

  it('fails only definitively unsupported legacy generation events before provider invocation', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 49)?.sql ?? ''
    expect(sql).toContain("event.event_type = 'generation.requested'")
    expect(sql).toContain('event.unknown_at IS NOT NULL')
    expect(sql).toContain("event.last_error->>'code' = 'UNSUPPORTED_EVENT_TYPE'")
    expect(sql).toContain("event.last_error->'retryable' = 'false'::jsonb")
    expect(sql).toContain("event.payload->>'job_id' = event.aggregate_id")
    expect(sql).toContain('job.workspace_id = unsupported.workspace_id')
    expect(sql).toContain("job.state IN ('queued', 'running')")
    expect(sql).toContain("error_code = 'LEGACY_GENERATION_EVENT_UNRECOVERABLE'")
    expect(sql).not.toContain("last_error->>'code' = 'TIMEOUT'")
  })

  postgresIt('backfills missing rows and preserves unsafe scopes on real PostgreSQL 001 through 049', async () => {
    const pool = new Pool({ connectionString: process.env.LEGACY_BACKFILL_DATABASE_URL })
    try {
      const migrations = await loadMigrations()
      await new MigrationRunner(pool, migrations.filter(item => item.version <= 48)).run()

      await pool.query(`INSERT INTO workspaces (id, status) VALUES ('ws_a', 'active'), ('ws_b', 'active')`)
      await pool.query(`INSERT INTO platform_accounts (id, workspace_id, platform, remote_account_id, credential_ref, token_state)
        VALUES ('acc_other', 'ws_b', 'jd', 'remote_other', 'secret://other', 'connected')`)
      await pool.query(`INSERT INTO brands (id, workspace_id, name) VALUES ('brand_other', 'ws_b', 'Other brand')`)
      await pool.query(`INSERT INTO products (id, workspace_id, platform, store_name, title, sku_count, stock, source, version, data)
        VALUES ('prod_existing', 'ws_a', 'jd', 'Existing store', 'Keep this title', 1, 5, 'fixture', 7, '{"marker":"keep"}')`)
      await pool.query(`INSERT INTO tasks (id, workspace_id, product_id, platform, state, version, data)
        VALUES ('task_existing', 'ws_a', 'prod_existing', 'jd', 'plan_confirmed', 1, '{}')`)
      await pool.query(`INSERT INTO generation_jobs (id, workspace_id, task_id, idempotency_key, state, attempt, data)
        VALUES ('job_existing', 'ws_a', 'task_existing', 'existing-idem', 'queued', 0, '{"marker":"existing"}')`)

      const snapshots = [
        ['product', 'prod_legacy', 3, { id: 'prod_legacy', workspaceId: 'ws_a', platform: 'jd', accountId: 'acc_other', storeName: 'Legacy store', remoteId: 'remote_legacy', title: 'Legacy product', skuCount: 2, stock: 8, price: 19.9, images: [], attributes: {}, factsConfirmed: true, source: 'fixture' }],
        ['product', 'prod_bad', 1, { id: 'prod_bad', workspaceId: 'ws_a', platform: 'unsafe', title: 'Unsafe product', skuCount: 1, stock: 1, source: 'fixture' }],
        ['product', 'prod_missing_remote', 1, { id: 'prod_missing_remote', workspaceId: 'ws_a', platform: 'jd', title: 'Missing remote id', skuCount: 1, stock: 1, images: [], attributes: {}, factsConfirmed: true, source: 'fixture' }],
        ['product', 'prod_missing_facts', 1, { id: 'prod_missing_facts', workspaceId: 'ws_a', platform: 'jd', title: 'Missing facts flag', skuCount: 1, stock: 1, images: [], attributes: {}, source: 'fixture' }],
        ['product', 'prod_existing', 9, { id: 'prod_existing', workspaceId: 'ws_a', platform: 'jd', storeName: 'Overwrite store', title: 'Must not overwrite', skuCount: 9, stock: 9, images: [], attributes: {}, factsConfirmed: false, source: 'fixture' }],
        ['task', 'task_legacy', 4, { id: 'task_legacy', workspaceId: 'ws_a', productId: 'prod_legacy', platform: 'jd', accountId: 'acc_other', brandId: 'brand_other', canonicalProductId: 'canonical_other', listingId: 'listing_other', campaignId: 'campaign_other', campaignItemId: 'item_other', state: 'plan_confirmed', selectedDirectionId: 'direction_1' }],
        ['task', 'task_orphan', 1, { id: 'task_orphan', workspaceId: 'ws_a', productId: 'missing_product', platform: 'jd', state: 'draft' }],
        ['generation_job', 'job_unsupported', 2, { id: 'job_unsupported', workspaceId: 'ws_a', taskId: 'task_legacy', idempotencyKey: 'unsupported-idem', state: 'queued', attempt: 0 }],
        ['generation_job', 'job_timeout', 2, { id: 'job_timeout', workspaceId: 'ws_a', taskId: 'task_legacy', idempotencyKey: 'timeout-idem', state: 'running', attempt: 1 }],
        ['generation_job', 'job_retryable', 2, { id: 'job_retryable', workspaceId: 'ws_a', taskId: 'task_legacy', idempotencyKey: 'retryable-idem', state: 'queued', attempt: 1 }],
        ['generation_job', 'job_orphan', 1, { id: 'job_orphan', workspaceId: 'ws_a', taskId: 'missing_task', idempotencyKey: 'orphan-idem', state: 'queued', attempt: 0 }],
      ] as const
      for (const [entityType, entityId, version, payload] of snapshots) {
        await pool.query(`INSERT INTO business_entity_snapshots (workspace_id, entity_type, entity_id, entity_version, payload)
          VALUES ('ws_a', $1, $2, $3, $4::jsonb)`, [entityType, entityId, version, JSON.stringify(payload)])
      }

      const outbox = [
        ['evt_unsupported', 'job_unsupported', 'job_unsupported', { code: 'UNSUPPORTED_EVENT_TYPE', message: 'Old worker did not support generation.requested', retryable: false }],
        ['evt_existing', 'job_existing', 'job_existing', { code: 'UNSUPPORTED_EVENT_TYPE', message: 'Existing job was never sent', retryable: false }],
        ['evt_timeout', 'job_timeout', 'job_timeout', { code: 'TIMEOUT', message: 'Unknown provider outcome', retryable: false }],
        ['evt_retryable', 'job_retryable', 'job_retryable', { code: 'UNSUPPORTED_EVENT_TYPE', message: 'New worker can retry', retryable: true }],
      ] as const
      for (const [eventId, aggregateId, payloadJobId, lastError] of outbox) {
        await pool.query(`INSERT INTO outbox_events (id, workspace_id, aggregate_id, event_type, sequence, payload, unknown_at, last_error)
          VALUES ($1, 'ws_a', $2, 'generation.requested', 1, $3::jsonb, now(), $4::jsonb)`, [eventId, aggregateId, JSON.stringify({ job_id: payloadJobId }), JSON.stringify(lastError)])
      }

      expect(await new MigrationRunner(pool, migrations.filter(item => item.version === 49)).run()).toEqual([49])

      const product = (await pool.query(`SELECT platform_account_id, title, version, data FROM products WHERE workspace_id='ws_a' AND id='prod_legacy'`)).rows[0]
      expect(product).toMatchObject({ platform_account_id: null, title: 'Legacy product', version: 3 })
      expect(product.data.accountId).toBe('acc_other')
      expect((await pool.query(`SELECT count(*)::int AS count FROM products WHERE id='prod_bad'`)).rows[0]?.count).toBe(0)
      expect((await pool.query(`SELECT remote_product_id, data FROM products WHERE id='prod_missing_remote'`)).rows[0]).toMatchObject({ remote_product_id: null, data: { id: 'prod_missing_remote', workspaceId: 'ws_a' } })
      expect((await pool.query(`SELECT facts_confirmed FROM products WHERE id='prod_missing_facts'`)).rows[0]).toEqual({ facts_confirmed: false })
      expect((await pool.query(`SELECT title, version, data FROM products WHERE id='prod_existing'`)).rows[0]).toMatchObject({ title: 'Keep this title', version: 7, data: { marker: 'keep' } })

      const task = (await pool.query(`SELECT platform_account_id, brand_id, canonical_product_id, listing_id, campaign_id, campaign_item_id, data FROM tasks WHERE workspace_id='ws_a' AND id='task_legacy'`)).rows[0]
      expect(task).toMatchObject({ platform_account_id: null, brand_id: null, canonical_product_id: null, listing_id: null, campaign_id: null, campaign_item_id: null })
      expect(task.data).toMatchObject({ brandId: 'brand_other', campaignId: 'campaign_other' })
      expect((await pool.query(`SELECT count(*)::int AS count FROM tasks WHERE id='task_orphan'`)).rows[0]?.count).toBe(0)

      const jobs = (await pool.query(`SELECT id, state, error_code, error_message, data FROM generation_jobs WHERE workspace_id='ws_a' ORDER BY id`)).rows
      expect(jobs.find(row => row.id === 'job_unsupported')).toMatchObject({ state: 'failed', error_code: 'LEGACY_GENERATION_EVENT_UNRECOVERABLE', error_message: 'Old worker did not support generation.requested' })
      expect(jobs.find(row => row.id === 'job_existing')).toMatchObject({ state: 'failed', error_code: 'LEGACY_GENERATION_EVENT_UNRECOVERABLE', data: { marker: 'existing' } })
      expect(jobs.find(row => row.id === 'job_timeout')).toMatchObject({ state: 'running', error_code: null })
      expect(jobs.find(row => row.id === 'job_retryable')).toMatchObject({ state: 'queued', error_code: null })
      expect(jobs.some(row => row.id === 'job_orphan')).toBe(false)

      const before = (await pool.query(`SELECT
        (SELECT count(*)::int FROM products) AS products,
        (SELECT count(*)::int FROM tasks) AS tasks,
        (SELECT count(*)::int FROM generation_jobs) AS jobs`)).rows[0]
      await pool.query(migrations.find(item => item.version === 49)!.sql)
      const after = (await pool.query(`SELECT
        (SELECT count(*)::int FROM products) AS products,
        (SELECT count(*)::int FROM tasks) AS tasks,
        (SELECT count(*)::int FROM generation_jobs) AS jobs`)).rows[0]
      expect(after).toEqual(before)

      expect(await new MigrationRunner(pool, migrations.filter(item => item.version === 50)).run()).toEqual([50])
      expect((await pool.query(`SELECT array_agg(version ORDER BY version) AS versions FROM schema_migrations`)).rows[0]?.versions).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
    } finally {
      await pool.end()
    }
  }, 60_000)
})
