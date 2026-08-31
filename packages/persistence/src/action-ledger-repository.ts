import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ActionKind = 'model_text' | 'model_image' | 'model_ocr' | 'model_video' | 'seo' | 'brief' | 'publish' | 'catalog_sync' | 'platform_connect' | 'image_edit' | 'creative_preview' | 'other'
export type ActionSettlement = 'included_quota' | 'entitlement' | 'wallet' | 'wallet_overage'
export type ActionState = 'settled' | 'refunded'
export type ActionSettlementStatus = 'authorized' | 'pending_receipt' | 'settled' | 'released' | 'refunded' | 'manual_attention'

export interface ActionLedgerRecord {
  id: string
  workspaceId: string
  actionKey: string
  actionKind: ActionKind
  settlement: ActionSettlement
  state: ActionState
  units: number
  amountFen: number
  actorId: string
  description: string
  createdAt: string
  taskId?: string
  campaignItemId?: string
  contextLinkId?: string
  contextHash?: string
  providerRequestId?: string
  reservedAmountFen?: number
  multiplier?: number
  settlementStatus?: ActionSettlementStatus
  refundedAt?: string
  refundReason?: string
}

export interface ActionLedgerRepository {
  record(input: Omit<ActionLedgerRecord, 'id' | 'createdAt' | 'state'> & { createdAt?: string }): Promise<ActionLedgerRecord>
  get(workspaceId: string, actionKey: string): Promise<ActionLedgerRecord | undefined>
  refund(input: { workspaceId: string; actionKey: string; reason: string }): Promise<{ refunded: boolean; record?: ActionLedgerRecord }>
  list(workspaceId: string, limit?: number): Promise<ActionLedgerRecord[]>
  listByScope(input: { workspaceId: string; taskId?: string; campaignItemId?: string; contextLinkId?: string; contextHash?: string; limit?: number }): Promise<ActionLedgerRecord[]>
  transitionSettlementStatus(input: { workspaceId: string; actionKey: string; from: ActionSettlementStatus[]; to: ActionSettlementStatus }): Promise<ActionLedgerRecord>
  settleProviderUsage(input: { workspaceId: string; actionKey: string; providerRequestId?: string; actualAmountFen: number }): Promise<void>
}

export class ActionLedgerSettlementConflictError extends Error {
  readonly code = 'ACTION_LEDGER_SETTLEMENT_CONFLICT'
  constructor() {
    super('ACTION_LEDGER_SETTLEMENT_CONFLICT')
    this.name = 'ActionLedgerSettlementConflictError'
  }
}

const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const associationFields = ['taskId', 'campaignItemId', 'contextLinkId', 'contextHash'] as const
const identityFields = ['actionKind', 'settlement', 'units', 'amountFen', 'actorId', 'description', 'reservedAmountFen', 'multiplier'] as const

function validateAssociations(input: Pick<ActionLedgerRecord, typeof associationFields[number]>) {
  if ((input.contextLinkId === undefined) !== (input.contextHash === undefined)) throw new Error('ACTION_LEDGER_CONTEXT_PAIR_REQUIRED')
}

function mergeAssociations(existing: ActionLedgerRecord, input: Pick<ActionLedgerRecord, typeof associationFields[number]>) {
  validateAssociations(input)
  for (const field of associationFields) {
    const current = existing[field]
    const incoming = input[field]
    if (current !== undefined && incoming !== undefined && current !== incoming) throw new Error('ACTION_LEDGER_ASSOCIATION_CONFLICT')
    if (current === undefined && incoming !== undefined) existing[field] = incoming
  }
  return existing
}

function assertSameActionIdentity(existing: ActionLedgerRecord, input: Pick<ActionLedgerRecord, typeof identityFields[number]>) {
  for (const field of identityFields) {
    if (existing[field] !== input[field]) throw new Error('ACTION_LEDGER_IDEMPOTENCY_CONFLICT')
  }
}

function validateScope(input: { taskId?: string; campaignItemId?: string; contextLinkId?: string; contextHash?: string }) {
  if (!associationFields.some(field => input[field] !== undefined)) throw new Error('ACTION_LEDGER_QUERY_SCOPE_REQUIRED')
}

export class MemoryActionLedgerRepository implements ActionLedgerRepository {
  private readonly rows = new Map<string, ActionLedgerRecord>()
  async record(input: Omit<ActionLedgerRecord, 'id' | 'createdAt' | 'state'> & { createdAt?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    validateAssociations(input)
    const key = `${workspaceId}:${input.actionKey}`
    const existing = this.rows.get(key)
    if (existing) { assertSameActionIdentity(existing, input); return mergeAssociations(existing, input) }
    const row: ActionLedgerRecord = { ...input, workspaceId, id: `action_${randomUUID()}`, state: 'settled', settlementStatus: input.settlementStatus ?? (input.settlement === 'wallet_overage' ? 'authorized' : 'settled'), createdAt: input.createdAt ?? new Date().toISOString() }
    this.rows.set(key, row)
    return row
  }
  async get(workspaceId: string, actionKey: string) { return this.rows.get(`${requireWorkspaceScope(workspaceId)}:${actionKey}`) }
  async refund(input: { workspaceId: string; actionKey: string; reason: string }) {
    const row = this.rows.get(`${input.workspaceId}:${input.actionKey}`)
    if (!row || row.state === 'refunded') return { refunded: false, ...(row ? { record: row } : {}) }
    row.state = 'refunded'; row.settlementStatus = 'refunded'; row.refundedAt = new Date().toISOString(); row.refundReason = input.reason
    return { refunded: true, record: row }
  }
  async list(workspaceId: string, limit = 100) { return [...this.rows.values()].filter(row => row.workspaceId === workspaceId).slice(-Math.min(1000, Math.max(1, limit))).reverse() }
  async listByScope(input: { workspaceId: string; taskId?: string; campaignItemId?: string; contextLinkId?: string; contextHash?: string; limit?: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId); validateScope(input)
    return [...this.rows.values()].filter(row => row.workspaceId === workspaceId && associationFields.every(field => input[field] === undefined || row[field] === input[field])).slice(-Math.min(1000, Math.max(1, input.limit ?? 100))).reverse()
  }
  async transitionSettlementStatus(input: { workspaceId: string; actionKey: string; from: ActionSettlementStatus[]; to: ActionSettlementStatus }) {
    const row = this.rows.get(`${requireWorkspaceScope(input.workspaceId)}:${input.actionKey}`)
    if (!row) throw new Error('ACTION_LEDGER_RECORD_NOT_FOUND')
    if (row.settlementStatus === input.to) return row
    if (!row.settlementStatus || !input.from.includes(row.settlementStatus)) throw new Error('ACTION_LEDGER_STATUS_CONFLICT')
    row.settlementStatus = input.to
    return row
  }
  async settleProviderUsage(input: { workspaceId: string; actionKey: string; providerRequestId?: string; actualAmountFen: number }) {
    const row = this.rows.get(`${requireWorkspaceScope(input.workspaceId)}:${input.actionKey}`)
    if (!row) throw new Error('ACTION_LEDGER_RECORD_NOT_FOUND')
    if (row.settlementStatus === 'settled' && row.providerRequestId === input.providerRequestId && row.amountFen === input.actualAmountFen) return
    if ((row.providerRequestId !== undefined && row.providerRequestId !== input.providerRequestId) || row.settlementStatus === 'settled') throw new ActionLedgerSettlementConflictError()
    row.providerRequestId = input.providerRequestId
    row.amountFen = input.actualAmountFen
    row.settlementStatus = 'settled'
  }
}

type ActionRow = { id: string; workspace_id: string; action_key: string; action_kind: ActionKind; settlement: ActionSettlement; state: ActionState; units: number; amount_fen: number | string; actor_id: string; description: string; created_at: string | Date; task_id: string | null; campaign_item_id: string | null; context_link_id: string | null; context_hash: string | null; provider_request_id: string | null; reserved_amount_fen: number | string | null; multiplier: number | string | null; settlement_status: ActionSettlementStatus | null; refunded_at: string | Date | null; refund_reason: string | null }
const map = (row: ActionRow): ActionLedgerRecord => ({ id: row.id, workspaceId: row.workspace_id, actionKey: row.action_key, actionKind: row.action_kind, settlement: row.settlement, state: row.state, units: row.units, amountFen: Number(row.amount_fen), actorId: row.actor_id, description: row.description, createdAt: iso(row.created_at), ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.campaign_item_id ? { campaignItemId: row.campaign_item_id } : {}), ...(row.context_link_id ? { contextLinkId: row.context_link_id } : {}), ...(row.context_hash ? { contextHash: row.context_hash } : {}), ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}), ...(row.reserved_amount_fen !== null ? { reservedAmountFen: Number(row.reserved_amount_fen) } : {}), ...(row.multiplier !== null ? { multiplier: Number(row.multiplier) } : {}), ...(row.settlement_status ? { settlementStatus: row.settlement_status } : {}), ...(row.refunded_at ? { refundedAt: iso(row.refunded_at) } : {}), ...(row.refund_reason ? { refundReason: row.refund_reason } : {}) })
const projection = 'id, workspace_id, action_key, action_kind, settlement, state, units, amount_fen, actor_id, description, created_at, task_id, campaign_item_id, context_link_id, context_hash, provider_request_id, reserved_amount_fen, multiplier, settlement_status, refunded_at, refund_reason'

export class PostgresActionLedgerRepository implements ActionLedgerRepository {
  constructor(private readonly pool: SqlPool) {}
  async record(input: Omit<ActionLedgerRecord, 'id' | 'createdAt' | 'state'> & { createdAt?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    validateAssociations(input)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<ActionRow>(`INSERT INTO action_ledger (id, workspace_id, action_key, action_kind, settlement, state, units, amount_fen, actor_id, description, created_at, task_id, campaign_item_id, context_link_id, context_hash, provider_request_id, reserved_amount_fen, multiplier, settlement_status) VALUES ($1,$2,$3,$4,$5,'settled',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (workspace_id, action_key) DO UPDATE SET task_id=COALESCE(action_ledger.task_id,EXCLUDED.task_id), campaign_item_id=COALESCE(action_ledger.campaign_item_id,EXCLUDED.campaign_item_id), context_link_id=COALESCE(action_ledger.context_link_id,EXCLUDED.context_link_id), context_hash=COALESCE(action_ledger.context_hash,EXCLUDED.context_hash) WHERE action_ledger.action_kind=EXCLUDED.action_kind AND action_ledger.settlement=EXCLUDED.settlement AND action_ledger.units=EXCLUDED.units AND action_ledger.amount_fen=EXCLUDED.amount_fen AND action_ledger.actor_id=EXCLUDED.actor_id AND action_ledger.description=EXCLUDED.description AND action_ledger.reserved_amount_fen IS NOT DISTINCT FROM EXCLUDED.reserved_amount_fen AND action_ledger.multiplier IS NOT DISTINCT FROM EXCLUDED.multiplier AND (action_ledger.task_id IS NULL OR EXCLUDED.task_id IS NULL OR action_ledger.task_id=EXCLUDED.task_id) AND (action_ledger.campaign_item_id IS NULL OR EXCLUDED.campaign_item_id IS NULL OR action_ledger.campaign_item_id=EXCLUDED.campaign_item_id) AND (action_ledger.context_link_id IS NULL OR EXCLUDED.context_link_id IS NULL OR action_ledger.context_link_id=EXCLUDED.context_link_id) AND (action_ledger.context_hash IS NULL OR EXCLUDED.context_hash IS NULL OR action_ledger.context_hash=EXCLUDED.context_hash) RETURNING ${projection}`, [randomUUID(), workspaceId, input.actionKey, input.actionKind, input.settlement, input.units, input.amountFen, input.actorId, input.description, input.createdAt ?? new Date().toISOString(), input.taskId ?? null, input.campaignItemId ?? null, input.contextLinkId ?? null, input.contextHash ?? null, input.providerRequestId ?? null, input.reservedAmountFen ?? null, input.multiplier ?? null, input.settlementStatus ?? (input.settlement === 'wallet_overage' ? 'authorized' : 'settled')])
      if (result.rows[0]) return map(result.rows[0])
      const existing = await client.query<ActionRow>(`SELECT ${projection} FROM action_ledger WHERE workspace_id=$1 AND action_key=$2`, [workspaceId, input.actionKey])
      if (!existing.rows[0]) throw new Error('ACTION_LEDGER_RECORD_NOT_WRITTEN')
      const mapped = map(existing.rows[0])
      assertSameActionIdentity(mapped, input)
      mergeAssociations(mapped, input)
      throw new Error('ACTION_LEDGER_ASSOCIATION_CONFLICT')
    })
  }
  async get(workspaceId: string, actionKey: string) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<ActionRow>(`SELECT ${projection} FROM action_ledger WHERE workspace_id=$1 AND action_key=$2`, [workspaceId, actionKey])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }
  async refund(input: { workspaceId: string; actionKey: string; reason: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const result = await client.query<ActionRow>(`UPDATE action_ledger SET state='refunded', settlement_status='refunded', refunded_at=now(), refund_reason=$3 WHERE workspace_id=$1 AND action_key=$2 AND state='settled' RETURNING ${projection}`, [input.workspaceId, input.actionKey, input.reason])
      if (!result.rows[0]) return { refunded: false }
      return { refunded: true, record: map(result.rows[0]) }
    })
  }
  async list(workspaceId: string, limit = 100) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<ActionRow>(`SELECT ${projection} FROM action_ledger WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [workspaceId, Math.min(1000, Math.max(1, limit))])
      return result.rows.map(map)
    })
  }
  async listByScope(input: { workspaceId: string; taskId?: string; campaignItemId?: string; contextLinkId?: string; contextHash?: string; limit?: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId); validateScope(input)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<ActionRow>(`SELECT ${projection} FROM action_ledger WHERE workspace_id=$1 AND ($2::text IS NULL OR task_id=$2) AND ($3::text IS NULL OR campaign_item_id=$3) AND ($4::text IS NULL OR context_link_id=$4) AND ($5::text IS NULL OR context_hash=$5) ORDER BY created_at DESC,id DESC LIMIT $6`, [workspaceId, input.taskId ?? null, input.campaignItemId ?? null, input.contextLinkId ?? null, input.contextHash ?? null, Math.min(1000, Math.max(1, input.limit ?? 100))])
      return result.rows.map(map)
    })
  }
  async transitionSettlementStatus(input: { workspaceId: string; actionKey: string; from: ActionSettlementStatus[]; to: ActionSettlementStatus }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const result = await client.query<ActionRow>(`UPDATE action_ledger SET settlement_status=$4 WHERE workspace_id=$1 AND action_key=$2 AND (settlement_status=$4 OR settlement_status=ANY($3::text[])) RETURNING ${projection}`, [input.workspaceId, input.actionKey, input.from, input.to])
      if (result.rows[0]) return map(result.rows[0])
      const existing = await client.query<ActionRow>(`SELECT ${projection} FROM action_ledger WHERE workspace_id=$1 AND action_key=$2`, [input.workspaceId, input.actionKey])
      if (!existing.rows[0]) throw new Error('ACTION_LEDGER_RECORD_NOT_FOUND')
      throw new Error('ACTION_LEDGER_STATUS_CONFLICT')
    })
  }
  async settleProviderUsage(input: { workspaceId: string; actionKey: string; providerRequestId?: string; actualAmountFen: number }) {
    await withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const selected = await client.query<ActionRow>(`SELECT ${projection} FROM action_ledger WHERE workspace_id=$1 AND action_key=$2 FOR UPDATE`, [input.workspaceId, input.actionKey])
      const row = selected.rows[0]
      if (!row) throw new Error('ACTION_LEDGER_RECORD_NOT_FOUND')
      const existingProviderRequestId = row.provider_request_id ?? undefined
      if (row.settlement_status === 'settled' && existingProviderRequestId === input.providerRequestId && Number(row.amount_fen) === input.actualAmountFen) return
      if ((existingProviderRequestId !== undefined && existingProviderRequestId !== input.providerRequestId) || row.settlement_status === 'settled') throw new ActionLedgerSettlementConflictError()
      await client.query(`UPDATE action_ledger SET amount_fen=$3, provider_request_id=$4, actual_cost_micros=$3::bigint*10000, settlement_status='settled' WHERE workspace_id=$1 AND action_key=$2`, [input.workspaceId, input.actionKey, input.actualAmountFen, input.providerRequestId ?? null])
    })
  }
}
