import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { PostgresOutboxRepository } from '../../../packages/persistence/src/repository.js'
import { contextEnvelopeHash } from '../../../packages/persistence/src/context-snapshot-repository.js'
import { loadMigrations, MigrationRunner } from '../../../packages/persistence/src/migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from '../../../packages/persistence/src/postgres-scope-fixture-cleanup.js'
import { assertGenerationKnowledgeExecution } from './main.js'

// The DB and queued event are real. The HTTP callback models the API's current
// selected-document comparison; this is not a live API or provider integration test.
const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const workspaceId = 'ws_knowledge_worker_fence'
const accountId = 'acct_knowledge_worker_fence'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function connection(base: URL, database: string, user?: string, password?: string) {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('PostgreSQL queued knowledge revocation before worker provider dispatch', () => {
  postgresIt('blocks provider dispatch after reindex, rights restriction, or approval revocation', async () => {
    const base = new URL(databaseUrl!)
    const databaseName = `release_211_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let created = false
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      created = true
      database = new Pool({ connectionString: connection(base, databaseName), max: 1 })
      const roleSql = (await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
        .replaceAll('ON DATABASE merchant ', `ON DATABASE "${databaseName}" `)
      await database.query(roleSql)
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query(roleSql)
      await database.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [workspaceId])
      await database.query(`INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state) VALUES ($1,$2,'taobao','remote-worker-knowledge','fixture-ref','active')`, [accountId, workspaceId])
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 3 })
      const knowledge = new PostgresKnowledgeRepository(app)
      const outbox = new PostgresOutboxRepository(app)
      const provider = vi.fn()
      for (const mutation of ['replaceChunks', 'restrictRights', 'revokeApproval'] as const) {
        const productId = `product_knowledge_worker_fence_${mutation}`
        await database.query(`INSERT INTO products (id,workspace_id,platform,platform_account_id,store_name,remote_product_id,title,source,data) VALUES ($1,$2,'taobao',$3,'Knowledge Store',$4,'Knowledge Worker Product','fixture','{}'::jsonb)`, [productId, workspaceId, accountId, `remote-worker-product-${mutation}`])
        const asset = await knowledge.createAsset({ workspaceId, kind: 'product_facts', name: `${mutation} asset`, content: { fixture: true }, productId, approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
        const document = await knowledge.createDocument({ workspaceId, knowledgeAssetId: asset.id, productId, knowledgeType: 'product_facts', title: `${mutation} document`, extractedText: `${mutation} approved knowledge`, contentHash: digest(mutation), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
        const admitted = await knowledge.search({ workspaceId, productId, platform: 'taobao', accountId, storeName: 'Knowledge Store' })
        const frozen = admitted.find(item => item.document.id === document.id)?.document
        expect(frozen).toBeDefined()
        const documents = [{ id: frozen!.id, title: frozen!.title, content: frozen!.extractedText, revision: frozen!.revision }]
        const taskId = `task_knowledge_${mutation}`
        const input = { platform: 'taobao', product: { id: productId }, knowledgeContext: { documents } }
        const queued = await outbox.append({ workspaceId, aggregateId: `gen_knowledge_${mutation}`, eventType: 'generation.requested', sequence: 1, payload: { task_id: taskId, input, context_hash: contextEnvelopeHash(input) } })
        const event = (await outbox.listAggregateEvents(workspaceId, queued.aggregateId)).find(item => item.id === queued.id)!
        if (mutation === 'replaceChunks') await knowledge.replaceChunks(workspaceId, document.id, [{ ordinal: 0, content: 'new content requiring reindex' }])
        else if (mutation === 'restrictRights') await knowledge.updateAsset(workspaceId, asset.id, { rightsStatus: 'restricted' })
        else await knowledge.updateAsset(workspaceId, asset.id, { approvalStatus: 'pending' })
        const current = (await knowledge.listDocuments(workspaceId, { productId })).find(item => item.id === document.id)!
        expect(current.revision).toBeGreaterThan(frozen!.revision)
        expect(current.indexState === 'ready' && current.approvalStatus === 'approved' && current.rightsStatus === 'cleared').toBe(false)
        const proof = { attempt: 1, providerAttemptKey: `mm-${'a'.repeat(64)}`, requestBodySha256: 'b'.repeat(64) }
        const fetcher: typeof fetch = async () => {
          const selected = await knowledge.search({ workspaceId, productId, platform: 'taobao', accountId, storeName: 'Knowledge Store' })
          const currentDocuments = selected.map(item => item.document)
          const changed = currentDocuments.length !== documents.length || documents.some((old, index) => {
            const now = currentDocuments[index]
            return !now || now.id !== old.id || now.revision !== old.revision || now.title !== old.title || now.extractedText !== old.content
          })
          return new Response(JSON.stringify({ error: { code: changed ? 'KNOWLEDGE_EXECUTION_CHANGED' : 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE' } }), { status: changed ? 409 : 503, headers: { 'content-type': 'application/json' } })
        }
        await expect((async () => {
          await assertGenerationKnowledgeExecution({ apiBaseUrl: 'http://127.0.0.1:18082', apiToken: 'disposable-token', signingSecret: 'disposable-secret', event, proof, fetcher })
          provider()
        })()).rejects.toMatchObject({ code: 'KNOWLEDGE_EXECUTION_CHANGED' })
        expect(provider).not.toHaveBeenCalled()
      }
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => undefined, primaryFailure, [
        async () => { await app?.end() },
        async () => { await database?.end() },
        async () => { if (created) await dropDrainedPostgresFixture(admin, databaseName) },
        () => admin.end(),
      ])
    }
  }, 300_000)
})
