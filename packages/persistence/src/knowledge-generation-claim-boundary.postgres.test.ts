import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { contextEnvelopeHash } from './context-snapshot-repository.js'
import { PostgresKnowledgeRepository } from './knowledge.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { PostgresOutboxRepository, SqlClient, SqlPool, SqlQueryResult, withWorkspaceTransaction } from './repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function databaseConnection(base: URL, database: string, user?: string, password?: string, applicationName?: string) {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  if (applicationName) url.searchParams.set('application_name', applicationName)
  return url.toString()
}

describe('migration 250 knowledge generation claim boundary', () => {
  postgresIt('isolates claim rows by workspace and serializes claim against a concurrent document mutation', async () => {
    const base = new URL(databaseUrl!)
    const databaseName = `release_claim_fence_${randomUUID().replaceAll('-', '')}`
    const workspaceId = `ws_claim_fence_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const otherWorkspaceId = `${workspaceId}_other`
    const productId = `product_claim_fence_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const concurrentProductId = `${productId}_race`
    const accountId = `acct_claim_fence_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const rlsRole = `claim_rls_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const rlsPassword = randomUUID().replaceAll('-', '')
    const rlsApplication = `claim_rls_probe_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const raceApplication = `claim_race_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let rls: Pool | undefined
    let roleCreated = false
    let databaseCreated = false
    let unblockMutation: (() => void) | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      databaseCreated = true
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString(), max: 4 })
      const roleSql = (await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
        .replaceAll('ON DATABASE merchant ', `ON DATABASE "${databaseName}" `)
      await database.query(roleSql)
      const migrations = (await loadMigrations()).filter(migration => migration.version <= 250)
      expect(migrations.at(-1)?.version).toBe(250)
      await new MigrationRunner(database, migrations).run()
      await database.query(roleSql)

      await database.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active'),($2,'active')`, [workspaceId, otherWorkspaceId])
      await database.query(`INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state) VALUES ($1,$2,'taobao',$3,'fixture-ref','active')`, [accountId, workspaceId, `remote-${accountId}`])
      for (const targetProduct of [productId, concurrentProductId]) {
        await database.query(`INSERT INTO products (id,workspace_id,platform,platform_account_id,store_name,remote_product_id,title,source,data) VALUES ($1,$2,'taobao',$3,'Claim Fence Store',$4,'Claim Fence Product','fixture','{}'::jsonb)`, [targetProduct, workspaceId, accountId, `remote-${targetProduct}`])
      }
      app = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only', raceApplication), max: 6 })
      const knowledge = new PostgresKnowledgeRepository(app)
      const outbox = new PostgresOutboxRepository(app)
      const bindGenerationRequest = async (suffix: string, targetProductId: string, selected: { id: string; title: string; extractedText: string; revision: number }) => {
        const taskId = `task_${suffix}`
        const jobId = `job_${suffix}`
        const input = { platform: 'taobao', product: { id: targetProductId }, knowledgeContext: { documents: [{ id: selected.id, title: selected.title, content: selected.extractedText, revision: selected.revision }] } }
        const contextHash = contextEnvelopeHash(input)
        await database!.query(`INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state) VALUES ($1,$2,$3,'taobao',$4,'generating')`, [taskId, workspaceId, targetProductId, accountId])
        await database!.query(`INSERT INTO generation_jobs (id,workspace_id,task_id,idempotency_key,state) VALUES ($1,$2,$3,$4,'queued')`, [jobId, workspaceId, taskId, `idem_${suffix}`])
        const event = await outbox.append({ workspaceId, aggregateId: jobId, eventType: 'generation.requested', sequence: 1, payload: { job_id: jobId, task_id: taskId, context_hash: contextHash, input } })
        return { taskId, jobId, aggregateId: jobId, eventId: event.id, contextHash }
      }
      const content = 'approved claim fence fact'
      const document = await knowledge.createDocument({ workspaceId, productId, knowledgeType: 'product_facts', title: 'claim fence', extractedText: content, contentHash: hash(content), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
      const execution = await bindGenerationRequest(randomUUID().replaceAll('-', ''), productId, document)
      const claimInput = {
        workspaceId, ...execution, logicalAttempt: 1,
        providerAttemptId: randomUUID(), providerAttemptKey: `mm-${'a'.repeat(64)}`, requestBodySha256: 'b'.repeat(64), requestNonce: randomUUID(),
        productId, expectedDocuments: [{ documentId: document.id, revision: document.revision, contentSha256: hash(content) }],
      }
      const claim = await knowledge.claimGenerationKnowledge(claimInput)
      expect(claim).toMatchObject({ claimed: true, state: 'claimed' })

      // Runtime access to the claim ledger is deliberately function-only.
      await expect(withWorkspaceTransaction(app, workspaceId, client => client.query('SELECT claim_id FROM knowledge_generation_claims')))
        .rejects.toMatchObject({ code: '42501' })
      await expect(withWorkspaceTransaction(app, workspaceId, client => client.query(
        `SELECT * FROM claim_knowledge_generation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [otherWorkspaceId, `claim_${randomUUID()}`, 'event', 'job', 'task', 1, 'attempt', 'key', 'body', 'nonce', 'product', 'context', '[]'],
      ))).rejects.toMatchObject({ code: '42501' })

      // Grant a separate non-owner probe role SELECT solely inside this fresh DB,
      // so the forced RLS policy can be tested independently of merchant_app's
      // intentionally revoked table privilege.
      await admin.query(`CREATE ROLE "${rlsRole}" LOGIN PASSWORD '${rlsPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
      roleCreated = true
      await database.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO "${rlsRole}"`)
      await database.query(`GRANT USAGE ON SCHEMA public TO "${rlsRole}"`)
      await database.query(`GRANT SELECT ON knowledge_generation_claims TO "${rlsRole}"`)
      rls = new Pool({ connectionString: databaseConnection(base, databaseName, rlsRole, rlsPassword, rlsApplication), max: 1 })
      const probe = await rls.connect()
      try {
        await probe.query('BEGIN')
        await probe.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId])
        await expect(probe.query('SELECT claim_id FROM knowledge_generation_claims WHERE claim_id=$1', [claim.claimId]))
          .resolves.toMatchObject({ rows: [{ claim_id: claim.claimId }] })
        await probe.query('ROLLBACK')
        await probe.query('BEGIN')
        await probe.query(`SELECT set_config('app.workspace_id',$1,true)`, [otherWorkspaceId])
        await expect(probe.query('SELECT claim_id FROM knowledge_generation_claims WHERE claim_id=$1', [claim.claimId]))
          .resolves.toMatchObject({ rows: [] })
        await probe.query('ROLLBACK')
      } finally {
        probe.release()
      }

      // Race the repository's actual reindex transaction against claim creation.
      // Hold reindex after its document/chunk triggers have taken the advisory
      // product lock, then prove PostgreSQL blocks claim until that transaction
      // commits and the claim sees the new document revision/state.
      const raceContent = 'before concurrent reindex'
      const raceDocument = await knowledge.createDocument({ workspaceId, productId: concurrentProductId, knowledgeType: 'product_facts', title: 'race doc', extractedText: raceContent, contentHash: hash(raceContent), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
      const raceExecution = await bindGenerationRequest(randomUUID().replaceAll('-', ''), concurrentProductId, raceDocument)
      const raceInput = {
        workspaceId, ...raceExecution, logicalAttempt: 1,
        providerAttemptId: randomUUID(), providerAttemptKey: `mm-${'d'.repeat(64)}`, requestBodySha256: 'e'.repeat(64), requestNonce: randomUUID(),
        productId: concurrentProductId, expectedDocuments: [{ documentId: raceDocument.id, revision: raceDocument.revision, contentSha256: hash(raceContent) }],
      }
      let mutationHeldResolve!: () => void
      let releaseMutationResolve!: () => void
      const mutationHeld = new Promise<void>(resolve => { mutationHeldResolve = resolve })
      const releaseMutationGate = new Promise<void>(resolve => { releaseMutationResolve = resolve })
      unblockMutation = releaseMutationResolve
      const gatedPool: SqlPool = {
        connect: async () => {
          const client = await app!.connect()
          const wrapped: SqlClient = {
            query: async <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
              const result = await client.query(text, values as unknown[] | undefined)
              if (text.startsWith("UPDATE knowledge_documents SET approval_status='pending'")) {
                mutationHeldResolve()
                await releaseMutationGate
              }
              return result as unknown as SqlQueryResult<Row>
            },
            release: error => client.release(error),
          }
          return wrapped
        },
      }
      const mutationRepository = new PostgresKnowledgeRepository(gatedPool)
      const mutation = mutationRepository.replaceChunks(workspaceId, raceDocument.id, [{ ordinal: 0, content: 'reindexed concurrent fact' }])
      await mutationHeld
      const pendingClaim = knowledge.claimGenerationKnowledge(raceInput)
      let waitingOnAdvisoryLock = false
      const waitDeadline = Date.now() + 5_000
      while (Date.now() < waitDeadline && !waitingOnAdvisoryLock) {
        const activity = await admin.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
             WHERE datname=$1 AND application_name=$2
               AND wait_event_type='Lock' AND query ILIKE '%claim_knowledge_generation%'
          ) AS waiting
        `, [databaseName, raceApplication])
        waitingOnAdvisoryLock = activity.rows[0]?.waiting === true
        if (!waitingOnAdvisoryLock) await new Promise(resolve => setTimeout(resolve, 20))
      }
      releaseMutationResolve()
      await mutation
      unblockMutation = undefined
      const racedClaim = await pendingClaim
      expect(waitingOnAdvisoryLock).toBe(true)
      expect(racedClaim).toMatchObject({ claimed: false, reason: 'snapshot_changed' })
    } catch (error) {
      primaryFailure = error
      unblockMutation?.()
      throw error
    } finally {
      unblockMutation?.()
      await withPostgresFixtureCleanup(async () => {
        await rls?.end()
        await app?.end()
        await database?.end()
        if (databaseCreated) await dropDrainedPostgresFixture(admin, databaseName)
        if (roleCreated) await admin.query(`DROP ROLE IF EXISTS "${rlsRole}"`)
      }, primaryFailure, [() => admin.end()])
    }
  }, 300_000)
})
