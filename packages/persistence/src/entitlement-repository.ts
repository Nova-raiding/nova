import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type EntitlementKind = 'platform' | 'image_generation' | 'bulk_sync'
export interface SubscriptionEntitlement {
  id: string
  workspaceId: string
  orderNo: string
  addonCode: string
  kind: EntitlementKind
  grantedUnits: number
  usedUnits: number
  remainingUnits: number
  createdAt: string
}

export interface EntitlementConsumption {
  id: string
  workspaceId: string
  entitlementId: string
  idempotencyKey: string
  units: number
  createdAt: string
  refundedAt?: string
}

export interface EntitlementRepository {
  grant(input: { workspaceId: string; orderNo: string; addonCode: string; kind: EntitlementKind; units: number }): Promise<SubscriptionEntitlement>
  list(workspaceId: string): Promise<SubscriptionEntitlement[]>
  consume(input: { workspaceId: string; kind: EntitlementKind; units: number; idempotencyKey: string }): Promise<EntitlementConsumption | undefined>
  refund(input: { workspaceId: string; idempotencyKey: string }): Promise<{ refunded: boolean; consumption?: EntitlementConsumption }>
}

export class EntitlementConsumptionIdempotencyConflictError extends Error {
  readonly code = 'ENTITLEMENT_CONSUMPTION_IDEMPOTENCY_CONFLICT'
  constructor() { super('entitlement consumption idempotency key was reused with a different intent'); this.name = 'EntitlementConsumptionIdempotencyConflictError' }
}

export class EntitlementGrantIdempotencyConflictError extends Error {
  readonly code = 'ENTITLEMENT_GRANT_IDEMPOTENCY_CONFLICT'
  constructor() { super('entitlement grant idempotency key was reused with a different intent'); this.name = 'EntitlementGrantIdempotencyConflictError' }
}

const projection = 'id, workspace_id AS "workspaceId", order_no AS "orderNo", addon_code AS "addonCode", kind, granted_units AS "grantedUnits", used_units AS "usedUnits", granted_units-used_units AS "remainingUnits", created_at AS "createdAt"'

export class MemoryEntitlementRepository implements EntitlementRepository {
  private readonly items = new Map<string, SubscriptionEntitlement>()
  private readonly consumptions = new Map<string, EntitlementConsumption>()
  async grant(input: { workspaceId: string; orderNo: string; addonCode: string; kind: EntitlementKind; units: number }) {
    if (!Number.isInteger(input.units) || input.units <= 0) throw new Error('ENTITLEMENT_UNITS_INVALID')
    const key = `${input.workspaceId}:${input.orderNo}:${input.addonCode}`
    const existing = this.items.get(key)
    if (existing) {
      if (existing.kind !== input.kind || existing.grantedUnits !== input.units) throw new EntitlementGrantIdempotencyConflictError()
      return existing
    }
    const item = { id: `ent_${randomUUID()}`, ...input, grantedUnits: input.units, usedUnits: 0, remainingUnits: input.units, createdAt: new Date().toISOString() }
    this.items.set(key, item)
    return item
  }
  async list(workspaceId: string) { return [...this.items.values()].filter(item => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  async consume(input: { workspaceId: string; kind: EntitlementKind; units: number; idempotencyKey: string }) {
    const existing = this.consumptions.get(`${input.workspaceId}:${input.idempotencyKey}`)
    if (existing) { if (existing.units !== input.units || [...this.items.values()].find(item => item.id === existing.entitlementId)?.kind !== input.kind) throw new EntitlementConsumptionIdempotencyConflictError(); return existing.refundedAt ? undefined : existing }
    const entitlement = [...this.items.values()].find(item => item.workspaceId === input.workspaceId && item.kind === input.kind && item.remainingUnits >= input.units)
    if (!entitlement) return undefined
    entitlement.usedUnits += input.units; entitlement.remainingUnits -= input.units
    const consumption = { id: `ent_use_${randomUUID()}`, workspaceId: input.workspaceId, entitlementId: entitlement.id, idempotencyKey: input.idempotencyKey, units: input.units, createdAt: new Date().toISOString() }
    this.consumptions.set(`${input.workspaceId}:${input.idempotencyKey}`, consumption)
    return consumption
  }
  async refund(input: { workspaceId: string; idempotencyKey: string }) {
    const key = `${input.workspaceId}:${input.idempotencyKey}`
    const consumption = this.consumptions.get(key)
    if (!consumption || consumption.refundedAt) return { refunded: false, ...(consumption ? { consumption } : {}) }
    const entitlement = [...this.items.values()].find(item => item.id === consumption.entitlementId && item.workspaceId === input.workspaceId)
    if (!entitlement) return { refunded: false, consumption }
    entitlement.usedUnits -= consumption.units; entitlement.remainingUnits += consumption.units; consumption.refundedAt = new Date().toISOString()
    return { refunded: true, consumption }
  }
}

export class PostgresEntitlementRepository implements EntitlementRepository {
  constructor(private readonly pool: SqlPool) {}
  async grant(input: { workspaceId: string; orderNo: string; addonCode: string; kind: EntitlementKind; units: number }) {
    if (!Number.isInteger(input.units) || input.units <= 0) throw new Error('ENTITLEMENT_UNITS_INVALID')
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const inserted = await client.query<SubscriptionEntitlement>(`INSERT INTO subscription_entitlements (id, workspace_id, order_no, addon_code, kind, granted_units) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id, order_no, addon_code) DO NOTHING RETURNING ${projection}`, [randomUUID(), input.workspaceId, input.orderNo, input.addonCode, input.kind, input.units])
      if (inserted.rows[0]) return inserted.rows[0]
      const existing = await client.query<SubscriptionEntitlement>(`SELECT ${projection} FROM subscription_entitlements WHERE workspace_id=$1 AND order_no=$2 AND addon_code=$3 FOR UPDATE`, [input.workspaceId, input.orderNo, input.addonCode])
      const entitlement = existing.rows[0]
      if (!entitlement) throw new Error('ENTITLEMENT_GRANT_IDEMPOTENCY_RECORD_MISSING')
      if (entitlement.kind !== input.kind || entitlement.grantedUnits !== input.units) throw new EntitlementGrantIdempotencyConflictError()
      return entitlement
    })
  }
  async list(workspaceId: string) {
    requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<SubscriptionEntitlement>(`SELECT ${projection} FROM subscription_entitlements WHERE workspace_id=$1 ORDER BY created_at DESC`, [workspaceId])).rows)
  }
  async consume(input: { workspaceId: string; kind: EntitlementKind; units: number; idempotencyKey: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const existing = await client.query<EntitlementConsumption & { kind: EntitlementKind }>(`SELECT c.id, c.workspace_id AS "workspaceId", c.entitlement_id AS "entitlementId", c.idempotency_key AS "idempotencyKey", c.units, c.created_at AS "createdAt", c.refunded_at AS "refundedAt", e.kind FROM subscription_entitlement_consumptions c JOIN subscription_entitlements e ON e.id=c.entitlement_id WHERE c.workspace_id=$1 AND c.idempotency_key=$2`, [input.workspaceId, input.idempotencyKey])
      if (existing.rows[0]) { if (existing.rows[0].units !== input.units || existing.rows[0].kind !== input.kind) throw new EntitlementConsumptionIdempotencyConflictError(); return existing.rows[0].refundedAt ? undefined : existing.rows[0] }
      const entitlement = await client.query<{ id: string }>('SELECT id FROM subscription_entitlements WHERE workspace_id=$1 AND kind=$2 AND granted_units-used_units >= $3 ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1', [input.workspaceId, input.kind, input.units])
      if (!entitlement.rows[0]) return undefined
      const id = randomUUID()
      const inserted = await client.query<EntitlementConsumption>(`INSERT INTO subscription_entitlement_consumptions (id, workspace_id, entitlement_id, idempotency_key, units) VALUES ($1,$2,$3,$4,$5) RETURNING id, workspace_id AS "workspaceId", entitlement_id AS "entitlementId", idempotency_key AS "idempotencyKey", units, created_at AS "createdAt", refunded_at AS "refundedAt"`, [id, input.workspaceId, entitlement.rows[0].id, input.idempotencyKey, input.units])
      await client.query('UPDATE subscription_entitlements SET used_units=used_units+$2 WHERE id=$1', [entitlement.rows[0].id, input.units])
      return inserted.rows[0]
    })
  }
  async refund(input: { workspaceId: string; idempotencyKey: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<EntitlementConsumption>(`UPDATE subscription_entitlement_consumptions SET refunded_at=now() WHERE workspace_id=$1 AND idempotency_key=$2 AND refunded_at IS NULL RETURNING id, workspace_id AS "workspaceId", entitlement_id AS "entitlementId", idempotency_key AS "idempotencyKey", units, created_at AS "createdAt", refunded_at AS "refundedAt"`, [input.workspaceId, input.idempotencyKey])
      if (!result.rows[0]) return { refunded: false }
      await client.query('UPDATE subscription_entitlements SET used_units=used_units-$2 WHERE id=$1', [result.rows[0].entitlementId, result.rows[0].units])
      return { refunded: true, consumption: result.rows[0] }
    })
  }
}
