import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { indexApprovedKnowledge } from '../../application/src/knowledge-lexical-index.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresKnowledgeRepository } from './knowledge.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

describe.skipIf(!databaseUrl)('PostgreSQL knowledge index CAS acceptance', () => {
  const databaseName = `knowledge_cas_${randomUUID().replaceAll('-', '')}`
  let admin: Pool | undefined
  let database: Pool | undefined
  let repository: PostgresKnowledgeRepository
  let databaseCreated = false

  beforeAll(async () => {
    const base = new URL(databaseUrl!)
    admin = new Pool({ connectionString: base.toString(), max: 2 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    databaseCreated = true
    const isolated = new URL(base)
    isolated.pathname = `/${databaseName}`
    database = new Pool({ connectionString: isolated.toString(), max: 4 })
    const migrations = await loadMigrations()
    expect(migrations.some(migration => migration.version === 183)).toBe(true)
    expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(migration => migration.version))
    repository = new PostgresKnowledgeRepository(database)
  }, 240_000)

  afterAll(async () => {
    await database?.end()
    if (databaseCreated) await admin?.query(`DROP DATABASE "${databaseName}"`)
    await admin?.end()
  })

  async function workspace() {
    const id = `ws_knowledge_${randomUUID()}`
    await database!.query('INSERT INTO workspaces (id,status) VALUES ($1,$2)', [id, 'active'])
    return id
  }

  async function document(workspaceId: string, value: string) {
    const created = await repository.createDocument({ workspaceId, knowledgeType: 'product_facts', extractedText: value, contentHash: sha(value), approvalStatus: 'approved', rightsStatus: 'cleared' })
    await repository.replaceChunks(workspaceId, created.id, [{ ordinal: 0, content: value }])
    await database!.query("UPDATE knowledge_documents SET approval_status='approved',rights_status='cleared',revision=revision+1 WHERE workspace_id=$1 AND id=$2", [workspaceId, created.id])
    return (await repository.listDocuments(workspaceId)).find(item => item.id === created.id)!
  }

  it('rejects a stale ready promotion after rights revocation and keeps the document invisible', async () => {
    const scope = await workspace()
    const queued = await document(scope, '原版商品事实')
    await database!.query("UPDATE knowledge_documents SET rights_status='restricted',revision=revision+1 WHERE workspace_id=$1 AND id=$2", [scope, queued.id])
    expect(await repository.transitionQueuedIndexState(scope, queued.id, 'ready', { revision: queued.revision, contentHash: queued.contentHash })).toBeUndefined()
    expect(await indexApprovedKnowledge({ repository, workspaceId: scope })).toMatchObject({ ready: 0, blocked: 1 })
    expect(await repository.search({ workspaceId: scope, query: '原版商品事实' })).toEqual([])
  })

  it('fences an old vector write after content replacement and reapproval', async () => {
    const scope = await workspace()
    const old = await document(scope, '旧版向量内容')
    const [oldChunk] = await repository.listChunks(scope, old.id)
    const oldInput = { documentId: old.id, chunkId: oldChunk!.id, expectedDocumentRevision: old.revision, expectedDocumentContentHash: old.contentHash, expectedChunkContentHash: oldChunk!.contentHash, embedding: [1, 0], embeddingModel: 'test', embeddingVersion: '1', indexState: 'ready' as const }
    await repository.upsertEmbedding(scope, oldInput)
    await repository.createDocument({ id: old.id, workspaceId: scope, knowledgeType: 'product_facts', extractedText: '新版向量内容', contentHash: sha('新版向量内容') })
    await repository.replaceChunks(scope, old.id, [{ ordinal: 0, content: '新版向量内容' }])
    await database!.query("UPDATE knowledge_documents SET approval_status='approved',rights_status='cleared',revision=revision+1 WHERE workspace_id=$1 AND id=$2", [scope, old.id])
    await expect(repository.upsertEmbedding(scope, oldInput)).rejects.toThrow('KNOWLEDGE_EMBEDDING_STALE')
    const count = await database!.query<{ count: string }>('SELECT count(*)::text AS count FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id=$2', [scope, old.id])
    expect(count.rows[0]?.count).toBe('0')
  })

  it('invalidates ready state on content and chunk replacement, then a fresh repository recovers queued work', async () => {
    const scope = await workspace()
    const queued = await document(scope, '第一版内容')
    expect(await indexApprovedKnowledge({ repository, workspaceId: scope })).toMatchObject({ ready: 1 })
    expect(await repository.search({ workspaceId: scope, query: '第一版内容' })).toHaveLength(1)
    const unchanged = await repository.createDocument({ id: queued.id, workspaceId: scope, knowledgeType: 'product_facts', extractedText: '第一版内容', contentHash: sha('第一版内容') })
    expect(unchanged).toMatchObject({ indexState: 'ready', approvalStatus: 'approved', rightsStatus: 'cleared' })
    const sameChunks = await repository.listChunks(scope, queued.id)
    await repository.replaceChunks(scope, queued.id, [{ ordinal: 0, content: '第一版内容' }])
    expect((await repository.listDocuments(scope)).find(item => item.id === queued.id)?.revision).toBe(unchanged.revision)
    expect((await repository.listChunks(scope, queued.id)).map(item => item.id)).toEqual(sameChunks.map(item => item.id))
    const changed = await repository.createDocument({ id: queued.id, workspaceId: scope, knowledgeType: 'product_facts', extractedText: '第二版内容', contentHash: sha('第二版内容') })
    expect(changed.indexState).toBe('queued')
    expect(changed).toMatchObject({ approvalStatus: 'pending', rightsStatus: 'unknown' })
    expect(await repository.search({ workspaceId: scope, query: '第二版内容' })).toEqual([])
    await repository.replaceChunks(scope, queued.id, [{ ordinal: 0, content: '第二版内容' }])
    expect(await repository.transitionQueuedIndexState(scope, queued.id, 'ready', { revision: queued.revision, contentHash: queued.contentHash })).toBeUndefined()
    const restarted = new PostgresKnowledgeRepository(database!)
    expect(await indexApprovedKnowledge({ repository: restarted, workspaceId: scope })).toMatchObject({ blocked: 1, ready: 0 })
    await database!.query("UPDATE knowledge_documents SET approval_status='approved',rights_status='cleared',revision=revision+1 WHERE workspace_id=$1 AND id=$2", [scope, queued.id])
    expect(await indexApprovedKnowledge({ repository: restarted, workspaceId: scope })).toMatchObject({ ready: 1 })
    expect(await restarted.search({ workspaceId: scope, query: '第二版内容' })).toHaveLength(1)
    await restarted.replaceChunks(scope, queued.id, [{ ordinal: 0, content: '篡改片段', contentHash: sha('非同一片段') }])
    expect(await restarted.search({ workspaceId: scope, query: '第二版内容' })).toEqual([])
    expect(await indexApprovedKnowledge({ repository: restarted, workspaceId: scope })).toMatchObject({ blocked: 1, ready: 0 })
    await database!.query("UPDATE knowledge_documents SET approval_status='approved',rights_status='cleared',revision=revision+1 WHERE workspace_id=$1 AND id=$2", [scope, queued.id])
    expect(await indexApprovedKnowledge({ repository: restarted, workspaceId: scope })).toMatchObject({ failed: 1 })
  })

  it('never promotes or reads another tenant document through a guessed identifier', async () => {
    const owner = await workspace()
    const outsider = await workspace()
    const queued = await document(owner, '租户私有知识')
    expect(await repository.transitionQueuedIndexState(outsider, queued.id, 'ready', { revision: queued.revision, contentHash: queued.contentHash })).toBeUndefined()
    expect(await repository.listChunks(outsider, queued.id)).toEqual([])
    expect(await indexApprovedKnowledge({ repository, workspaceId: outsider })).toMatchObject({ ready: 0 })
    expect(await repository.search({ workspaceId: outsider, query: '租户私有知识' })).toEqual([])
  })
})
