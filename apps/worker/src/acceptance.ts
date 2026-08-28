import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PostgresOutboxRepository, type SqlPool } from '../../../packages/persistence/src/index.js'
import { pollOnce, readWorkerConfig } from './main.js'

/**
 * Real PostgreSQL acceptance: the second poll uses a fresh dispatcher map,
 * which is the same recovery boundary as a process restart.
 *
 * Run after migrations with DATABASE_URL and WORKER_WORKSPACES configured:
 *   npx tsx apps/worker/src/acceptance.ts
 */
const config = readWorkerConfig({ ...process.env, WORKER_ONCE: 'true' })
const workspaceId = config.workspaces[0]!
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 })
const repository = new PostgresOutboxRepository(pool as unknown as SqlPool)
const suffix = randomUUID()

try {
  await repository.append({ workspaceId, aggregateId: `acceptance_snapshot_${suffix}`, eventType: 'state.snapshot', sequence: 1, payload: { entityType: 'task', entity: { id: `task_${suffix}` } } })
  await repository.append({ workspaceId, aggregateId: `acceptance_task_${suffix}`, eventType: 'task.created', sequence: 1, payload: { id: `task_${suffix}`, workspaceId } })
  await repository.append({ workspaceId, aggregateId: `acceptance_publish_${suffix}`, eventType: 'publish.requested', sequence: 1, payload: { id: `job_${suffix}`, workspaceId } })

  const first = await pollOnce(repository, new Map(), config)
  if (first.succeeded !== 2 || first.unknown !== 1 || first.processed !== 3) {
    throw new Error(`unexpected first poll result: ${JSON.stringify(first)}`)
  }

  // New dispatcher instances model a restart. Acked events must not replay;
  // unknown publish work must remain excluded until manual reconciliation.
  const second = await pollOnce(repository, new Map(), config)
  if (second.restored !== 0 || second.processed !== 0) {
    throw new Error(`events replayed after restart: ${JSON.stringify(second)}`)
  }
  process.stdout.write(`${JSON.stringify({ profile: 'real_postgres_worker_restart', workspaceId, first, second, publishOutcome: 'unknown_manual_reconciliation' })}\n`)
} finally {
  await pool.end()
}
