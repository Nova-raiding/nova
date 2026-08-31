import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface ContextSnapshotLink {
  id: string
  workspaceId: string
  contextHash: string
  brandId?: string
  campaignId?: string
  campaignItemId?: string
  taskId?: string
  canonicalProductId?: string
  listingId?: string
  versions: Record<string, unknown>
  createdAt: string
}

export interface ContextSnapshotRecord extends ContextSnapshotLink {
  envelope: Record<string, unknown>
  inputTokensEstimate: number
  maxInputTokens: number
}

export interface SaveContextSnapshotInput {
  workspaceId: string
  brandId?: string
  envelope: Record<string, unknown>
  inputTokensEstimate: number
  maxInputTokens: number
  versions?: Record<string, unknown>
  campaignId?: string
  campaignItemId?: string
  taskId?: string
  canonicalProductId?: string
  listingId?: string
  linkId?: string
}

export interface ContextSnapshotRepository {
  save(input: SaveContextSnapshotInput): Promise<ContextSnapshotRecord>
  getByTask(input: { workspaceId: string; taskId: string }): Promise<ContextSnapshotRecord | undefined>
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
}

/** Request/audit identifiers are not business context. Keeping them out of
 * the blob key lets retries and equivalent actions reuse the immutable
 * context bytes while their individual link rows remain auditable. */
function stableEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  const { usageContext: _usageContext, ...businessContext } = envelope
  return businessContext
}

export function contextEnvelopeHash(envelope: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(canonical(stableEnvelope(envelope)))).digest('hex')
}

function validate(input: SaveContextSnapshotInput) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  if (input.brandId !== undefined && !input.brandId.trim()) throw new Error('CONTEXT_SNAPSHOT_BRAND_INVALID')
  if ((input.campaignId === undefined) !== (input.campaignItemId === undefined)) throw new Error('CONTEXT_SNAPSHOT_CAMPAIGN_PAIR_REQUIRED')
  if (!Number.isInteger(input.inputTokensEstimate) || input.inputTokensEstimate < 0) throw new Error('CONTEXT_SNAPSHOT_TOKEN_ESTIMATE_INVALID')
  if (!Number.isInteger(input.maxInputTokens) || input.maxInputTokens < 1 || input.inputTokensEstimate > input.maxInputTokens) throw new Error('CONTEXT_SNAPSHOT_TOKEN_BUDGET_INVALID')
  return workspaceId
}

export class MemoryContextSnapshotRepository implements ContextSnapshotRepository {
  private readonly blobs = new Map<string, Pick<ContextSnapshotRecord, 'envelope' | 'inputTokensEstimate' | 'maxInputTokens'>>()
  private readonly links = new Map<string, ContextSnapshotLink>()

  async save(input: SaveContextSnapshotInput) {
    const workspaceId = validate(input)
    const contextHash = contextEnvelopeHash(input.envelope)
    const blobKey = `${workspaceId}:${contextHash}`
    const envelope = canonical(stableEnvelope(input.envelope)) as Record<string, unknown>
    const existingBlob = this.blobs.get(blobKey)
    if (existingBlob && JSON.stringify(existingBlob.envelope) !== JSON.stringify(envelope)) throw new Error('CONTEXT_HASH_COLLISION')
    if (!existingBlob) this.blobs.set(blobKey, { envelope, inputTokensEstimate: input.inputTokensEstimate, maxInputTokens: input.maxInputTokens })
    const id = input.linkId ?? `context_link_${randomUUID()}`
    const linkKey = `${workspaceId}:${id}`
    const existingLink = this.links.get(linkKey)
    if (existingLink) {
      if (existingLink.contextHash !== contextHash) throw new Error('CONTEXT_LINK_IDEMPOTENCY_CONFLICT')
      return { ...existingLink, ...this.blobs.get(blobKey)! }
    }
    const link: ContextSnapshotLink = { id, workspaceId, contextHash, ...(input.brandId ? { brandId: input.brandId } : {}), ...(input.campaignId ? { campaignId: input.campaignId, campaignItemId: input.campaignItemId! } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.canonicalProductId ? { canonicalProductId: input.canonicalProductId } : {}), ...(input.listingId ? { listingId: input.listingId } : {}), versions: input.versions ?? {}, createdAt: new Date().toISOString() }
    this.links.set(linkKey, link)
    return { ...link, ...this.blobs.get(blobKey)! }
  }

  async getByTask(input: { workspaceId: string; taskId: string }) {
    const link = [...this.links.values()].filter(item => item.workspaceId === input.workspaceId && item.taskId === input.taskId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    if (!link) return undefined
    return { ...link, ...this.blobs.get(`${link.workspaceId}:${link.contextHash}`)! }
  }
}

type LinkRow = { id: string; workspace_id: string; context_hash: string; brand_id: string | null; campaign_id: string | null; campaign_item_id: string | null; task_id: string | null; canonical_product_id: string | null; listing_id: string | null; versions: Record<string, unknown>; created_at: string | Date; envelope: Record<string, unknown>; input_tokens_estimate: number; max_input_tokens: number }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const projection = `l.id,l.workspace_id,l.context_hash,l.brand_id,l.campaign_id,l.campaign_item_id,l.task_id,l.canonical_product_id,l.listing_id,l.versions,l.created_at,b.envelope,b.input_tokens_estimate,b.max_input_tokens`
const map = (row: LinkRow): ContextSnapshotRecord => ({ id: row.id, workspaceId: row.workspace_id, contextHash: row.context_hash, ...(row.brand_id ? { brandId: row.brand_id } : {}), ...(row.campaign_id ? { campaignId: row.campaign_id, campaignItemId: row.campaign_item_id! } : {}), ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.canonical_product_id ? { canonicalProductId: row.canonical_product_id } : {}), ...(row.listing_id ? { listingId: row.listing_id } : {}), versions: row.versions, createdAt: iso(row.created_at), envelope: row.envelope, inputTokensEstimate: row.input_tokens_estimate, maxInputTokens: row.max_input_tokens })

export class PostgresContextSnapshotRepository implements ContextSnapshotRepository {
  constructor(private readonly pool: SqlPool) {}
  async save(input: SaveContextSnapshotInput) {
    const workspaceId = validate(input)
    const envelope = canonical(stableEnvelope(input.envelope)) as Record<string, unknown>
    const contextHash = contextEnvelopeHash(envelope)
    const linkId = input.linkId ?? `context_link_${randomUUID()}`
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await client.query(`INSERT INTO context_blobs (workspace_id,context_hash,envelope,input_tokens_estimate,max_input_tokens) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,context_hash) DO NOTHING`, [workspaceId, contextHash, envelope, input.inputTokensEstimate, input.maxInputTokens])
      const blob = await client.query<{ envelope: Record<string, unknown> }>('SELECT envelope FROM context_blobs WHERE workspace_id=$1 AND context_hash=$2', [workspaceId, contextHash])
      if (!blob.rows[0] || JSON.stringify(canonical(blob.rows[0].envelope)) !== JSON.stringify(envelope)) throw new Error('CONTEXT_HASH_COLLISION')
      await client.query(`INSERT INTO context_snapshot_links (id,workspace_id,context_hash,brand_id,campaign_id,campaign_item_id,task_id,canonical_product_id,listing_id,versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (workspace_id,id) DO NOTHING`, [linkId, workspaceId, contextHash, input.brandId, input.campaignId ?? null, input.campaignItemId ?? null, input.taskId ?? null, input.canonicalProductId ?? null, input.listingId ?? null, input.versions ?? {}])
      const result = await client.query<LinkRow>(`SELECT ${projection} FROM context_snapshot_links l JOIN context_blobs b ON b.workspace_id=l.workspace_id AND b.context_hash=l.context_hash WHERE l.workspace_id=$1 AND l.id=$2`, [workspaceId, linkId])
      if (!result.rows[0]) throw new Error('CONTEXT_SNAPSHOT_NOT_WRITTEN')
      if (result.rows[0].context_hash !== contextHash) throw new Error('CONTEXT_LINK_IDEMPOTENCY_CONFLICT')
      return map(result.rows[0])
    })
  }
  async getByTask(input: { workspaceId: string; taskId: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const result = await client.query<LinkRow>(`SELECT ${projection} FROM context_snapshot_links l JOIN context_blobs b ON b.workspace_id=l.workspace_id AND b.context_hash=l.context_hash WHERE l.workspace_id=$1 AND l.task_id=$2 ORDER BY l.created_at DESC,l.id DESC LIMIT 1`, [input.workspaceId, input.taskId])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }
}
