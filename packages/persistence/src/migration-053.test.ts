import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'

const postgresIt = process.env.LEGACY_BACKFILL_DATABASE_URL ? it : it.skip

describe('053 terminal generation outbox cleanup', () => {
  it('matches only exact, same-workspace, terminal generation requests', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 53)
    expect(migration).toMatchObject({ name: 'terminal_generation_outbox_cleanup' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain("event.event_type = 'generation.requested'")
    expect(sql).toContain('job.workspace_id = event.workspace_id')
    expect(sql).toContain('job.id = event.aggregate_id')
    expect(sql).toContain("jsonb_typeof(event.payload->'job_id') = 'string'")
    expect(sql).toContain("event.payload->>'job_id' = event.aggregate_id")
    expect(sql).toContain("job.state IN ('succeeded', 'failed')")
    expect(sql).toContain('event.published_at IS NULL')
  })

  it('dead-letters without deleting evidence or broadening tenant access', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 53)?.sql ?? ''
    expect(sql).toContain('published_at = now()')
    expect(sql).toContain('lease_token = NULL')
    expect(sql).toContain('lease_until = NULL')
    expect(sql).toContain("'retryable', false")
    expect(sql).toContain("'previousError', event.last_error")
    expect(sql).not.toMatch(/DELETE FROM|TRUNCATE TABLE|DROP TABLE|DROP COLUMN|SECURITY DEFINER/i)
  })

  postgresIt('cleans only exact terminal rows on real PostgreSQL and is idempotent', async () => {
    const pool = new Pool({ connectionString: process.env.LEGACY_BACKFILL_DATABASE_URL })
    try {
      const migrations = await loadMigrations()
      await new MigrationRunner(pool, migrations.filter(item => item.version <= 52)).run()

      const suffix = Date.now().toString(36)
      const workspaceA = `ws_cleanup_a_${suffix}`
      const workspaceB = `ws_cleanup_b_${suffix}`
      const productA = `prod_cleanup_a_${suffix}`
      const productB = `prod_cleanup_b_${suffix}`
      const taskA = `task_cleanup_a_${suffix}`
      const taskB = `task_cleanup_b_${suffix}`
      await pool.query(`INSERT INTO workspaces (id, status) VALUES ($1, 'active'), ($2, 'active')`, [workspaceA, workspaceB])
      await pool.query(`INSERT INTO products (id, workspace_id, platform, title, sku_count, stock, source, data)
        VALUES ($1, $2, 'jd', 'A', 1, 1, 'fixture', '{}'), ($3, $4, 'jd', 'B', 1, 1, 'fixture', '{}')`, [productA, workspaceA, productB, workspaceB])
      await pool.query(`INSERT INTO tasks (id, workspace_id, product_id, platform, state, data)
        VALUES ($1, $2, $3, 'jd', 'plan_confirmed', '{}'), ($4, $5, $6, 'jd', 'plan_confirmed', '{}')`, [taskA, workspaceA, productA, taskB, workspaceB, productB])

      const jobs = [
        [`job_succeeded_${suffix}`, workspaceA, taskA, 'succeeded'],
        [`job_failed_${suffix}`, workspaceA, taskA, 'failed'],
        [`job_running_${suffix}`, workspaceA, taskA, 'running'],
        [`job_other_${suffix}`, workspaceB, taskB, 'failed'],
      ] as const
      for (const [id, workspaceId, taskId, state] of jobs) {
        await pool.query(`INSERT INTO generation_jobs (id, workspace_id, task_id, idempotency_key, state)
          VALUES ($1, $2, $3, $4, $5)`, [id, workspaceId, taskId, `idem_${id}`, state])
      }

      const events = [
        [`evt_success_${suffix}`, workspaceA, jobs[0][0], jobs[0][0], { code: 'TIMEOUT', retryable: true }],
        [`evt_failed_${suffix}`, workspaceA, jobs[1][0], jobs[1][0], null],
        [`evt_running_${suffix}`, workspaceA, jobs[2][0], jobs[2][0], { code: 'TIMEOUT', retryable: true }],
        [`evt_malformed_${suffix}`, workspaceA, jobs[0][0], 'wrong_job', { code: 'TIMEOUT', retryable: true }],
        [`evt_other_${suffix}`, workspaceB, jobs[3][0], jobs[3][0], { code: 'TIMEOUT', retryable: true }],
        [`evt_cross_tenant_${suffix}`, workspaceA, jobs[3][0], jobs[3][0], { code: 'TIMEOUT', retryable: true }],
      ] as const
      for (const [index, [id, workspaceId, aggregateId, payloadJobId, lastError]] of events.entries()) {
        await pool.query(`INSERT INTO outbox_events
          (id, workspace_id, aggregate_id, event_type, sequence, payload, next_attempt_at, lease_token, lease_until, last_error)
          VALUES ($1, $2, $3, 'generation.requested', $4, $5::jsonb, now() + interval '8 hours', 'old-lease', now() + interval '8 hours', $6::jsonb)`,
        [id, workspaceId, aggregateId, index + 1, JSON.stringify({ job_id: payloadJobId }), JSON.stringify(lastError)])
      }

      expect(await new MigrationRunner(pool, migrations.filter(item => item.version === 53)).run()).toEqual([53])
      const rows = (await pool.query(`SELECT id, workspace_id, published_at, next_attempt_at <= now() AS due,
        lease_token, lease_until, last_error FROM outbox_events WHERE id = ANY($1::text[]) ORDER BY id`, [events.map(item => item[0])])).rows
      for (const id of [events[0][0], events[1][0], events[4][0]]) {
        expect(rows.find(row => row.id === id)).toMatchObject({ published_at: expect.any(Date), due: true, lease_token: null, lease_until: null, last_error: { code: 'GENERATION_JOB_TERMINAL', retryable: false } })
      }
      expect(rows.find(row => row.id === events[0][0])?.last_error.previousError).toEqual({ code: 'TIMEOUT', retryable: true })
      for (const id of [events[2][0], events[3][0], events[5][0]]) {
        expect(rows.find(row => row.id === id)).toMatchObject({ published_at: null, due: false, lease_token: 'old-lease' })
      }

      const before = JSON.stringify(rows)
      await pool.query(migrations.find(item => item.version === 53)!.sql)
      const after = JSON.stringify((await pool.query(`SELECT id, workspace_id, published_at, next_attempt_at <= now() AS due,
        lease_token, lease_until, last_error FROM outbox_events WHERE id = ANY($1::text[]) ORDER BY id`, [events.map(item => item[0])])).rows)
      expect(after).toBe(before)
    } finally {
      await pool.end()
    }
  }, 60_000)
})
