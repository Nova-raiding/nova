import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'

const fixturePool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://merchant_app:merchant_app_local_only@127.0.0.1:54329/merchant' })
const baseUrl = process.env.CANONICAL_BACKFILL_API_BASE_URL ?? 'http://127.0.0.1:8787'

type RpcBody<T = unknown> = {
  data: { result: T } | null
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

type BackfillRun = {
  id: string
  workspaceId: string
  status: 'planned' | 'running' | 'paused' | 'completed' | 'failed'
  dryRun: boolean
  revision: number
  reason: string
}

async function call<T>(input: {
  method: string
  workspaceId: string
  params?: Record<string, unknown>
}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer pilot-local-token',
      'content-type': 'application/json',
      'x-workspace-id': input.workspaceId,
      'x-ops-workbench': 'platform',
      'x-role': 'platform_ops',
      'x-actor-id': 'actor_demo',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `canonical-backfill-${input.method}-${Date.now()}`,
      method: input.method,
      params: { workspace_id: input.workspaceId, ...(input.params ?? {}) },
    }),
  })
  return { response, body: await response.json() as RpcBody<T> }
}

async function seedRun(workspaceId: string, input: { dryRun: boolean; status?: BackfillRun['status']; lastResult?: Record<string, unknown> } = { dryRun: true }) {
  const id = `backfill_contract_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const client = await fixturePool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId])
    await client.query(`INSERT INTO workspaces (id, status) VALUES ($1, 'active') ON CONFLICT (id) DO NOTHING`, [workspaceId])
    await client.query(
      `INSERT INTO canonical_backfill_runs (id, workspace_id, status, dry_run, batch_limit, last_result, revision, created_by, reason)
       VALUES ($1, $2, $3, $4, 25, $5::jsonb, 1, 'canonical-backfill-contract-actor', 'canonical backfill contract test')`,
      [id, workspaceId, input.status ?? 'planned', input.dryRun, JSON.stringify(input.lastResult ?? {})],
    )
    await client.query('COMMIT')
    return { id, workspaceId, status: input.status ?? 'planned', dryRun: input.dryRun, revision: 1, reason: 'canonical backfill contract test' } satisfies BackfillRun
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

describe('canonical data governance backfill API contract', () => {
  beforeEach(() => vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000'))

  afterAll(async () => { await fixturePool.end() })

  it('executes a durable dry-run with an explicit bounded batch contract', async () => {
    const workspaceId = `ws_canonical_backfill_dry_run_${Date.now()}`
    const run = await seedRun(workspaceId)

    const executed = await call<{ run: BackfillRun; batch: { dryRun: boolean } }>({
      method: 'ops.canonical.backfill.run',
      workspaceId,
      params: { run_id: run.id, expected_revision: '1' },
    })

    expect(executed.response.status).toBe(200)
    expect(executed.body.error).toBeNull()
    expect(executed.body.data?.result).toMatchObject({
      batch: { dryRun: true },
      run: { workspaceId, dryRun: true, reason: 'canonical backfill contract test' },
    })
    expect(run).toMatchObject({
      workspaceId,
      status: 'planned',
      dryRun: true,
      revision: 1,
      reason: 'canonical backfill contract test',
    })
  })

  it('returns a stable conflict code when a terminal state is mutated again', async () => {
    const workspaceId = `ws_canonical_backfill_conflict_${Date.now()}`
    const run = await seedRun(workspaceId)

    const paused = await call<BackfillRun>({
      method: 'ops.canonical.backfill.pause',
      workspaceId,
      params: { run_id: run.id, expected_revision: String(run.revision), reason: 'pause for conflict contract' },
    })
    expect(paused.response.status).toBe(200)
    expect(paused.body.data?.result).toMatchObject({ id: run.id, status: 'paused', revision: 2 })

    const conflict = await call({
      method: 'ops.canonical.backfill.pause',
      workspaceId,
      params: { run_id: run.id, expected_revision: '2', reason: 'repeated pause must conflict' },
    })
    expect(conflict.response.status).toBe(409)
    expect(conflict.body.data).toBeNull()
    expect(conflict.body.error).toMatchObject({ code: 'CANONICAL_BACKFILL_RUN_STATE_INVALID' })
  })

  it('supports a revision-bound pause and resume sequence', async () => {
    const workspaceId = `ws_canonical_backfill_pause_resume_${Date.now()}`
    const run = await seedRun(workspaceId, { dryRun: false })

    const paused = await call<BackfillRun>({
      method: 'ops.canonical.backfill.pause',
      workspaceId,
      params: { run_id: run.id, expected_revision: String(run.revision), reason: 'pause before local execution' },
    })
    expect(paused.response.status).toBe(200)
    expect(paused.body.data?.result).toMatchObject({ status: 'paused', revision: 2 })

    const resumed = await call<BackfillRun>({
      method: 'ops.canonical.backfill.resume',
      workspaceId,
      params: { run_id: run.id, expected_revision: '2', reason: 'resume after local review' },
    })
    expect(resumed.response.status).toBe(200)
    expect(resumed.body.data?.result).toMatchObject({ id: run.id, workspaceId, status: 'running', revision: 3 })
  })

  it('retries an executor failure but keeps conflict failures terminal', async () => {
    const retryWorkspace = `ws_canonical_backfill_retry_${Date.now()}`
    const failed = await seedRun(retryWorkspace, { dryRun: true, status: 'failed', lastResult: { error: 'temporary executor failure' } })
    const retried = await call<{ run: BackfillRun }>({ method: 'ops.canonical.backfill.run', workspaceId: retryWorkspace, params: { run_id: failed.id, expected_revision: '1' } })
    expect(retried.response.status).toBe(200)
    expect(retried.body.error).toBeNull()
    expect(retried.body.data?.result.run).toMatchObject({ id: failed.id, status: 'completed', revision: 3 })

    const conflictWorkspace = `ws_canonical_backfill_retry_conflict_${Date.now()}`
    const conflicted = await seedRun(conflictWorkspace, { dryRun: true, status: 'failed', lastResult: { conflicts: [{ code: 'MISSING_BRAND' }] } })
    const blocked = await call({ method: 'ops.canonical.backfill.run', workspaceId: conflictWorkspace, params: { run_id: conflicted.id, expected_revision: '1' } })
    expect(blocked.response.status).toBe(409)
    expect(blocked.body.error).toMatchObject({ code: 'CANONICAL_BACKFILL_RUN_STATE_INVALID' })
  })

  it('does not reveal a run from another workspace and keeps the error code stable', async () => {
    const ownerWorkspace = `ws_canonical_backfill_owner_${Date.now()}`
    const foreignWorkspace = `ws_canonical_backfill_foreign_${Date.now()}`
    const run = await seedRun(ownerWorkspace)

    const result = await call({
      method: 'ops.canonical.backfill.get',
      workspaceId: foreignWorkspace,
      params: { run_id: run.id },
    })

    expect(result.response.status).toBe(404)
    expect(result.body.data).toBeNull()
    expect(result.body.error).toMatchObject({ code: 'CANONICAL_BACKFILL_RUN_NOT_FOUND' })
    expect(JSON.stringify(result.body)).not.toContain(ownerWorkspace)
  })

  it('requires a run id and returns a stable validation code', async () => {
    const workspaceId = `ws_canonical_backfill_missing_id_${Date.now()}`
    const result = await call({ method: 'ops.canonical.backfill.get', workspaceId })

    expect(result.response.status).toBe(400)
    expect(result.body.data).toBeNull()
    expect(result.body.error).toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
