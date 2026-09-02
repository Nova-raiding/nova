import { createHash, randomUUID } from 'node:crypto'
import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type CommercialContractErrorCode =
  | 'COMMERCIAL_CATALOG_UNAVAILABLE'
  | 'COMMERCIAL_IDEMPOTENCY_CONFLICT'
  | 'COMMERCIAL_ORDER_NOT_FOUND'
  | 'COMMERCIAL_PAYMENT_MISMATCH'
  | 'COMMERCIAL_POLICY_UNRESOLVED'
  | 'PRIVATE_SKU_NOT_FOUND'

export class CommercialContractError extends Error {
  constructor(readonly code: CommercialContractErrorCode, message: string) {
    super(message)
    this.name = 'CommercialContractError'
  }
}

export interface CommercialOrderV2 {
  id: string
  workspaceId: string
  skuId: string
  skuVersionId: string
  amountFen: number
  currency: 'CNY'
  paymentProvider: string
  status: 'pending' | 'paid' | 'failed' | 'closed' | 'refunded' | 'reconciliation_required'
  idempotencyKey: string
  requestHash: string
  createdByActorId: string
  providerOrderId: string | null
  createdAt: string
  paidAt: string | null
}
export interface CommercialOrderListItemV2 extends CommercialOrderV2 { skuCode: string }

export interface CreateCommercialOrderInput {
  workspaceId: string
  sku: CommercialCatalogSkuSnapshot
  paymentProvider: string
  createdByActorId: string
  idempotencyKey: string
  reason: string
  /** Required in addition to capability for a private SKU. */
  privateEligibilityId?: string
  now?: string
}

export interface VerifiedPaymentGrantInput {
  workspaceId: string
  orderId: string
  provider: string
  providerEventId: string
  providerOrderId: string
  nonce: string
  payloadHash: string
  amountFen: number
  currency: 'CNY'
  paidAt: string
  /** Server-derived period. Monthly periods are checked as one calendar month; private periods as exactly seven days. */
  period?: { start: string; end: string }
  grantExpiresAt?: string | null
}

export interface PaymentGrantResult {
  order: CommercialOrderV2
  grantId: string
  accessRevision: number
  availablePoints: number
  replayed: boolean
}
export interface CommercialOrderPaymentStatusV2 { order: CommercialOrderV2; skuCode: string; accessRevision: number | null }

export interface CommercialEntitlementSnapshotV2 {
  id: string
  workspaceId: string
  subscriptionPeriodId: string
  periodStart: string
  periodEnd: string
  periodStatus: string
  catalogVersionId: string
  skuCode: string
  resolvedBenefits: unknown[]
  unresolvedBlockers: string[]
  executable: boolean
  checksum: string
  createdAt: string
}

export interface CommercialAccessDecisionFactV2 {
  id: string
  workspaceId: string
  requestId: string
  operationKey: string
  accessClass: 'RECOVERY_CONTROL' | 'POINT_REQUIRED_NO_CHARGE' | 'POINT_CHARGED'
  balanceState: 'known' | 'unknown'
  availablePoints: number | null
  reservedPoints: number | null
  quotedPoints: number | null
  accessRevision: number
  rateCardVersion: string | null
  allowed: boolean
  code: 'OK' | 'CREATIVE_POINTS_EXHAUSTED' | 'CREATIVE_POINTS_INSUFFICIENT' | 'CREATIVE_POINTS_UNAVAILABLE' | 'RATE_CARD_UNAVAILABLE' | 'COMMERCIAL_ACCESS_STALE'
  nextActions: string[]
  decidedAt: string
}

type OrderRow = {
  id: string
  workspaceId: string
  skuId: string
  skuVersionId: string
  amountFen: string | number
  currency: 'CNY'
  paymentProvider: string
  status: CommercialOrderV2['status']
  idempotencyKey: string
  requestHash: string
  createdByActorId: string
  providerOrderId: string | null
  createdAt: string | Date
  paidAt: string | Date | null
}

const orderProjection = `id, workspace_id AS "workspaceId", sku_id AS "skuId", sku_version_id AS "skuVersionId",
  amount_fen AS "amountFen", currency, payment_provider AS "paymentProvider", status,
  idempotency_key AS "idempotencyKey", request_hash AS "requestHash",
  created_by_actor_id AS "createdByActorId", provider_order_id AS "providerOrderId",
  created_at AS "createdAt", paid_at AS "paidAt"`
const aliasedOrderProjection = (alias: string) => `${alias}.id, ${alias}.workspace_id AS "workspaceId", ${alias}.sku_id AS "skuId", ${alias}.sku_version_id AS "skuVersionId",
  ${alias}.amount_fen AS "amountFen", ${alias}.currency, ${alias}.payment_provider AS "paymentProvider", ${alias}.status,
  ${alias}.idempotency_key AS "idempotencyKey", ${alias}.request_hash AS "requestHash",
  ${alias}.created_by_actor_id AS "createdByActorId", ${alias}.provider_order_id AS "providerOrderId",
  ${alias}.created_at AS "createdAt", ${alias}.paid_at AS "paidAt"`

function required(value: string | undefined, field: string): string {
  if (!value || value.trim() !== value || value.length === 0) throw new TypeError(`${field} is required`)
  return value
}

function instant(value: string, field: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new TypeError(`${field} must be an ISO timestamp`)
  return parsed.toISOString()
}

function safeInteger(value: string | number, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', `${field} is invalid`)
  return parsed
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const timestamp = (value: string | Date | null): string | null => value === null ? null : value instanceof Date ? value.toISOString() : String(value)
const mapOrder = (row: OrderRow): CommercialOrderV2 => ({ ...row, amountFen: safeInteger(row.amountFen, 'amountFen'), createdAt: timestamp(row.createdAt)!, paidAt: timestamp(row.paidAt) })

function validateOrderSku(sku: CommercialCatalogSkuSnapshot, now: string): void {
  if (sku.lifecycle !== 'approved' || !sku.executable || sku.effectiveAt === null || Date.parse(sku.effectiveAt) > Date.parse(now)) {
    throw new CommercialContractError('COMMERCIAL_CATALOG_UNAVAILABLE', 'SKU is not an active approved executable version')
  }
  if (sku.priceMode !== 'fixed' || sku.priceFen === null || sku.currency !== 'CNY') {
    throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'only a fixed approved CNY SKU can create an order')
  }
}

function pointBenefit(snapshot: CommercialCatalogSkuSnapshot): number {
  const code = snapshot.kind === 'monthly' ? 'monthly_creative_points' : 'creative_points'
  const values = snapshot.benefits.filter(benefit => benefit.code === code && benefit.quantity !== null)
  if (values.length !== 1 || !Number.isSafeInteger(values[0]!.quantity) || values[0]!.quantity! <= 0) {
    throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'SKU has no unique positive creative-point benefit')
  }
  return values[0]!.quantity!
}

function validatePeriod(sku: CommercialCatalogSkuSnapshot, period: VerifiedPaymentGrantInput['period']): { start: string; end: string } | null {
  if (sku.kind === 'point_pack') return null
  if (sku.kind === 'onboarding') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'onboarding grant schedule dates remain unresolved')
  if (!period) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'an approved subscription period is required')
  const start = instant(period.start, 'period.start')
  const end = instant(period.end, 'period.end')
  const expected = new Date(start)
  if (sku.kind === 'private_trial') expected.setUTCDate(expected.getUTCDate() + 7)
  else expected.setUTCMonth(expected.getUTCMonth() + 1)
  if (end !== expected.toISOString()) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', sku.kind === 'private_trial' ? 'private trial period must be exactly seven days' : 'monthly subscription period must be one calendar month')
  return { start, end }
}

/**
 * Commercial order/payment unit of work. It never reads legacy task, add-on or
 * RMB-wallet balances. The caller must verify the provider signature before
 * invoking `recordVerifiedPaymentAndGrant`; this repository then verifies the
 * immutable order facts and commits payment, contract, grant, revision, audit
 * and outbox in one PostgreSQL transaction.
 */
export class PostgresCommercialContractRepository {
  constructor(private readonly pool: SqlPool) {}

  async listOrders(workspaceId: string, limit = 100): Promise<CommercialOrderListItemV2[]> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit must be between 1 and 200')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OrderRow & { skuCode: string }>(
        `SELECT ${aliasedOrderProjection('o')},s.code AS "skuCode"
           FROM commercial_orders_v2 o JOIN commercial_catalog_skus s ON s.id=o.sku_id
          WHERE o.workspace_id=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT $2`, [scope, limit],
      )
      return result.rows.map(row => ({ ...mapOrder(row), skuCode: row.skuCode }))
    })
  }

  async listEntitlementSnapshots(workspaceId: string, limit = 100): Promise<CommercialEntitlementSnapshotV2[]> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit must be between 1 and 200')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      type Row = { id: string; workspaceId: string; subscriptionPeriodId: string; periodStart: string | Date; periodEnd: string | Date; periodStatus: string; catalogVersionId: string; skuCode: string; resolvedBenefits: unknown; unresolvedBlockers: unknown; executable: boolean; checksum: string; createdAt: string | Date }
      const result = await client.query<Row>(
        `SELECT e.id,e.workspace_id AS "workspaceId",e.subscription_period_id AS "subscriptionPeriodId",
                p.period_start AS "periodStart",p.period_end AS "periodEnd",p.status AS "periodStatus",
                e.catalog_version_id AS "catalogVersionId",s.code AS "skuCode",e.resolved_benefits AS "resolvedBenefits",
                e.unresolved_blockers AS "unresolvedBlockers",e.executable,e.checksum,e.created_at AS "createdAt"
           FROM workspace_entitlement_snapshots_v2 e
           JOIN workspace_subscription_periods_v2 p
             ON p.workspace_id=e.workspace_id AND p.id=e.subscription_period_id
           JOIN commercial_catalog_sku_versions v ON v.id=e.catalog_version_id
           JOIN commercial_catalog_skus s ON s.id=v.sku_id
          WHERE e.workspace_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT $2`, [scope, limit],
      )
      return result.rows.map(row => {
        if (!Array.isArray(row.resolvedBenefits) || !Array.isArray(row.unresolvedBlockers) || !row.unresolvedBlockers.every(item => typeof item === 'string')) {
          throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'entitlement snapshot payload is invalid')
        }
        return { ...row, periodStart: timestamp(row.periodStart)!, periodEnd: timestamp(row.periodEnd)!, createdAt: timestamp(row.createdAt)!, resolvedBenefits: row.resolvedBenefits, unresolvedBlockers: row.unresolvedBlockers as string[] }
      })
    })
  }

  async listAccessDecisions(workspaceId: string, options: { blockedOnly?: boolean; limit?: number } = {}): Promise<CommercialAccessDecisionFactV2[]> {
    const scope = requireWorkspaceScope(workspaceId)
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit must be between 1 and 200')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      type Row = Omit<CommercialAccessDecisionFactV2, 'availablePoints' | 'reservedPoints' | 'quotedPoints' | 'accessRevision' | 'nextActions' | 'decidedAt'> & { availablePoints: string | number | null; reservedPoints: string | number | null; quotedPoints: string | number | null; accessRevision: string | number; nextActions: unknown; decidedAt: string | Date }
      const result = await client.query<Row>(
        `SELECT id,workspace_id AS "workspaceId",request_id AS "requestId",operation_key AS "operationKey",
                access_class AS "accessClass",balance_state AS "balanceState",available_points AS "availablePoints",
                reserved_points AS "reservedPoints",quoted_points AS "quotedPoints",access_revision AS "accessRevision",
                rate_card_version AS "rateCardVersion",allowed,code,next_actions AS "nextActions",decided_at AS "decidedAt"
           FROM commercial_access_decisions_v2
          WHERE workspace_id=$1 AND ($2::boolean=false OR allowed=false)
          ORDER BY decided_at DESC,id DESC LIMIT $3`, [scope, options.blockedOnly === true, limit],
      )
      return result.rows.map(row => {
        if (!Array.isArray(row.nextActions) || !row.nextActions.every(item => typeof item === 'string')) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'access decision next actions are invalid')
        return {
          ...row,
          availablePoints: row.availablePoints === null ? null : safeInteger(row.availablePoints, 'availablePoints'),
          reservedPoints: row.reservedPoints === null ? null : safeInteger(row.reservedPoints, 'reservedPoints'),
          quotedPoints: row.quotedPoints === null ? null : safeInteger(row.quotedPoints, 'quotedPoints'),
          accessRevision: safeInteger(row.accessRevision, 'accessRevision'),
          nextActions: row.nextActions as string[],
          decidedAt: timestamp(row.decidedAt)!,
        }
      })
    })
  }

  async getPaymentStatus(workspaceId: string, orderId: string): Promise<CommercialOrderPaymentStatusV2 | null> {
    const scope = requireWorkspaceScope(workspaceId); required(orderId, 'orderId')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OrderRow & { skuCode: string; accessRevision: string | number | null }>(
        `SELECT ${aliasedOrderProjection('o')},s.snapshot->'sku'->>'code' AS "skuCode",l.access_revision AS "accessRevision"
           FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id
           LEFT JOIN creative_point_grants g ON g.workspace_id=o.workspace_id AND g.source_type='commercial_order_v2' AND g.source_id=o.id
           LEFT JOIN creative_point_ledger_events l ON l.workspace_id=g.workspace_id AND l.operation_id=g.operation_id AND l.event_type='granted'
          WHERE o.workspace_id=$1 AND o.id=$2 LIMIT 1`, [scope, orderId],
      )
      const row = result.rows[0]
      return row ? { order: mapOrder(row), skuCode: row.skuCode, accessRevision: row.accessRevision === null ? null : safeInteger(row.accessRevision, 'accessRevision') } : null
    })
  }

  async createOrder(input: CreateCommercialOrderInput): Promise<CommercialOrderV2> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const idempotencyKey = required(input.idempotencyKey, 'idempotencyKey')
    const paymentProvider = required(input.paymentProvider, 'paymentProvider')
    const actorId = required(input.createdByActorId, 'createdByActorId')
    const reason = required(input.reason, 'reason')
    const at = instant(input.now ?? new Date().toISOString(), 'now')
    validateOrderSku(input.sku, at)
    const request = {
      sku_id: input.sku.id, sku_version_id: input.sku.versionId, catalog_checksum: input.sku.checksum,
      amount_fen: input.sku.priceFen, currency: input.sku.currency, payment_provider: paymentProvider,
      actor_id: actorId, reason, private_eligibility_id: input.privateEligibilityId ?? null,
    }
    const requestHash = digest(request)

    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      if (input.sku.visibility === 'private') {
        const eligibilityId = required(input.privateEligibilityId, 'privateEligibilityId')
        const eligibility = await client.query(
          `SELECT id FROM private_trial_eligibilities_v2
            WHERE workspace_id=$1 AND id=$2 AND status='approved' AND expires_at>$3::timestamptz
            LIMIT 1`,
          [workspaceId, eligibilityId, at],
        )
        if (!eligibility.rows[0]) throw new CommercialContractError('PRIVATE_SKU_NOT_FOUND', 'private SKU was not found')
      }
      const id = `cor_${randomUUID()}`
      const inserted = await client.query<OrderRow>(
        `INSERT INTO commercial_orders_v2
          (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11::timestamptz)
         ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
         RETURNING ${orderProjection}`,
        [id, workspaceId, input.sku.id, input.sku.versionId, input.sku.priceFen, input.sku.currency, paymentProvider, idempotencyKey, requestHash, actorId, at],
      )
      const row = inserted.rows[0]
      if (!row) {
        const existing = await client.query<OrderRow>(`SELECT ${orderProjection} FROM commercial_orders_v2 WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, idempotencyKey])
        if (!existing.rows[0] || existing.rows[0].requestHash !== requestHash) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'commercial order idempotency key was reused for another intent')
        return mapOrder(existing.rows[0])
      }
      const snapshot = { schema_version: 'commercial-order.v2', sku: input.sku, private_eligibility_id: input.privateEligibilityId ?? null }
      await client.query(
        `INSERT INTO commercial_order_snapshots_v2
          (id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz)`,
        [`cos_${randomUUID()}`, workspaceId, id, input.sku.id, input.sku.versionId, input.sku.checksum, JSON.stringify(snapshot), digest(snapshot), at],
      )
      await client.query(
        `INSERT INTO commercial_access_decisions_v2
          (id,workspace_id,request_id,operation_key,access_class,balance_state,available_points,reserved_points,quoted_points,access_revision,rate_card_version,allowed,code,next_actions,evidence,decided_at)
         VALUES ($1,$2,$3,'commercial.order.create','RECOVERY_CONTROL','unknown',NULL,NULL,NULL,0,NULL,true,'OK','[]'::jsonb,$4::jsonb,$5::timestamptz)`,
        [`cad_${randomUUID()}`, workspaceId, idempotencyKey, JSON.stringify({ actor_id: actorId, reason, sku_version_id: input.sku.versionId }), at],
      )
      await client.query(
        `INSERT INTO outbox_events (id,workspace_id,aggregate_id,event_type,sequence,payload)
         VALUES ($1,$2,$3,'commercial.order_created',1,$4::jsonb)`,
        [`evt_${randomUUID()}`, workspaceId, id, JSON.stringify({ order_id: id, sku_code: input.sku.code, sku_version_id: input.sku.versionId, actor_id: actorId, reason })],
      )
      return mapOrder(row)
    })
  }

  async recordVerifiedPaymentAndGrant(input: VerifiedPaymentGrantInput): Promise<PaymentGrantResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const paidAt = instant(input.paidAt, 'paidAt')
    required(input.providerEventId, 'providerEventId'); required(input.providerOrderId, 'providerOrderId')
    required(input.nonce, 'nonce'); required(input.payloadHash, 'payloadHash')
    if (!/^[0-9a-f]{64}$/u.test(input.payloadHash)) throw new TypeError('payloadHash must be sha256 hex')
    if (!Number.isSafeInteger(input.amountFen) || input.amountFen < 0) throw new TypeError('amountFen must be a non-negative integer')

    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const loaded = await client.query<OrderRow & { snapshotId: string; snapshot: { sku: CommercialCatalogSkuSnapshot } }>(
        `SELECT ${aliasedOrderProjection('o')}, s.id AS "snapshotId", s.snapshot
           FROM commercial_orders_v2 o
           JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id
          WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o`,
        [workspaceId, input.orderId],
      )
      const row = loaded.rows[0]
      if (!row) throw new CommercialContractError('COMMERCIAL_ORDER_NOT_FOUND', 'commercial order was not found')
      const order = mapOrder(row)
      const sku = row.snapshot.sku
      if (order.paymentProvider !== input.provider || order.amountFen !== input.amountFen || order.currency !== input.currency) {
        throw new CommercialContractError('COMMERCIAL_PAYMENT_MISMATCH', 'provider, amount or currency does not match immutable order snapshot')
      }
      validateOrderSku(sku, paidAt)
      const period = validatePeriod(sku, input.period)
      const points = pointBenefit(sku)
      let expiresAt = input.grantExpiresAt == null ? null : instant(input.grantExpiresAt, 'grantExpiresAt')
      if (sku.kind === 'point_pack') {
        if ((sku.payload.expiryRule ?? null) === null || expiresAt === null) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'point-pack expiry policy remains unresolved')
      } else if (period) {
        expiresAt = period.end
      }

      const prior = await client.query<{ payloadHash: string; orderId: string }>(
        `SELECT payload_hash AS "payloadHash", order_id AS "orderId" FROM commercial_payment_events_v2
          WHERE provider=$1 AND provider_event_id=$2`, [input.provider, input.providerEventId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].payloadHash !== input.payloadHash || prior.rows[0].orderId !== input.orderId || order.status !== 'paid') {
          throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'provider payment event was reused for another intent')
        }
        const grant = await client.query<{ id: string }>(`SELECT id FROM creative_point_grants WHERE workspace_id=$1 AND source_type='commercial_order_v2' AND source_id=$2`, [workspaceId, input.orderId])
        const balance = await client.query<{ available: string | number; revision: string | number }>(`SELECT available_points AS available, revision FROM creative_point_access_state WHERE workspace_id=$1`, [workspaceId])
        if (!grant.rows[0] || !balance.rows[0]) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'paid order is missing atomic grant facts')
        return { order, grantId: grant.rows[0].id, availablePoints: safeInteger(balance.rows[0].available, 'availablePoints'), accessRevision: safeInteger(balance.rows[0].revision, 'revision'), replayed: true }
      }

      await client.query(
        `INSERT INTO commercial_payment_events_v2
          (id,workspace_id,order_id,provider,provider_event_id,nonce,payload_hash,event_type,verified,amount_fen,currency,received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',true,$8,$9,$10::timestamptz)`,
        [`cpe_${randomUUID()}`, workspaceId, input.orderId, input.provider, input.providerEventId, input.nonce, input.payloadHash, input.amountFen, input.currency, paidAt],
      )
      if (period) {
        const periodId = `csp_${randomUUID()}`
        await client.query(
          `INSERT INTO workspace_subscription_periods_v2
            (id,workspace_id,order_snapshot_id,period_start,period_end,status,revision,created_at)
           VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,'active',1,$6::timestamptz)`,
          [periodId, workspaceId, row.snapshotId, period.start, period.end, paidAt],
        )
        const blockers = Array.isArray(sku.payload.blockers) ? sku.payload.blockers : []
        await client.query(
          `INSERT INTO workspace_entitlement_snapshots_v2
            (id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,resolved_benefits,unresolved_blockers,executable,checksum,created_at)
           VALUES ($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7,$8,$9::timestamptz)`,
          [`ces_${randomUUID()}`, workspaceId, periodId, sku.versionId, JSON.stringify(sku.benefits), JSON.stringify(blockers), blockers.length === 0, digest({ benefits: sku.benefits, blockers }), paidAt],
        )
      }

      await client.query(
        `INSERT INTO creative_point_access_state (workspace_id,available_points,reserved_points,settled_points,revision,updated_at)
         VALUES ($1,0,0,0,0,$2::timestamptz) ON CONFLICT (workspace_id) DO NOTHING`, [workspaceId, paidAt],
      )
      await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      const operationId = `cpo_${randomUUID()}`
      const grantId = `cpg_${randomUUID()}`
      const operationRequest = { source_type: 'commercial_order_v2', source_id: input.orderId, points, expires_at: expiresAt, payment_event_id: input.providerEventId }
      await client.query(
        `INSERT INTO creative_point_operations (id,workspace_id,kind,idempotency_key,status,request,created_at)
         VALUES ($1,$2,'grant',$3,'pending',$4::jsonb,$5::timestamptz)`,
        [operationId, workspaceId, `payment:${input.provider}:${input.providerEventId}`, JSON.stringify(operationRequest), paidAt],
      )
      await client.query(
        `INSERT INTO creative_point_grants (id,workspace_id,operation_id,source_type,source_id,points,expires_at,metadata,created_at)
         VALUES ($1,$2,$3,'commercial_order_v2',$4,$5,$6::timestamptz,$7::jsonb,$8::timestamptz)`,
        [grantId, workspaceId, operationId, input.orderId, points, expiresAt, JSON.stringify({ sku_version_id: sku.versionId, payment_event_id: input.providerEventId }), paidAt],
      )
      const balance = await client.query<{ available: string | number; reserved: string | number; settled: string | number; revision: string | number }>(
        `UPDATE creative_point_access_state
            SET available_points=COALESCE(available_points,0)+$2,
                reserved_points=COALESCE(reserved_points,0), settled_points=COALESCE(settled_points,0),
                revision=revision+1, updated_at=$3::timestamptz
          WHERE workspace_id=$1
          RETURNING available_points AS available, reserved_points AS reserved, settled_points AS settled, revision`,
        [workspaceId, points, paidAt],
      )
      const state = balance.rows[0]!
      const revision = safeInteger(state.revision, 'revision')
      await client.query(
        `INSERT INTO creative_point_ledger_events
          (id,workspace_id,operation_id,event_type,points_delta,available_after,reserved_after,settled_after,access_revision,metadata,created_at)
         VALUES ($1,$2,$3,'granted',$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`,
        [`cpl_${randomUUID()}`, workspaceId, operationId, points, state.available, state.reserved, state.settled, revision, JSON.stringify({ order_id: input.orderId }), paidAt],
      )
      await client.query(`UPDATE creative_point_operations SET status='completed',result=jsonb_build_object('entity_id',$3::text),completed_at=$4::timestamptz WHERE workspace_id=$1 AND id=$2`, [workspaceId, operationId, grantId, paidAt])
      const paid = await client.query<OrderRow>(
        `UPDATE commercial_orders_v2 SET status='paid',provider_order_id=$3,paid_at=$4::timestamptz
          WHERE workspace_id=$1 AND id=$2 AND status='pending' RETURNING ${orderProjection}`,
        [workspaceId, input.orderId, input.providerOrderId, paidAt],
      )
      if (!paid.rows[0]) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'commercial order cannot transition to paid')
      await this.appendRecoveryDecision(client, workspaceId, input.orderId, state.available, state.reserved, revision, paidAt)
      await client.query(
        `INSERT INTO outbox_events (id,workspace_id,aggregate_id,event_type,sequence,payload)
         VALUES ($1,$2,$3,'commercial.payment_grant_committed',1,$4::jsonb)`,
        [`evt_${randomUUID()}`, workspaceId, input.orderId, JSON.stringify({ order_id: input.orderId, grant_id: grantId, access_revision: revision, payment_event_id: input.providerEventId })],
      )
      return { order: mapOrder(paid.rows[0]), grantId, availablePoints: safeInteger(state.available, 'availablePoints'), accessRevision: revision, replayed: false }
    })
  }

  private async appendRecoveryDecision(client: SqlClient, workspaceId: string, requestId: string, available: string | number, reserved: string | number, revision: number, decidedAt: string): Promise<void> {
    await client.query(
      `INSERT INTO commercial_access_decisions_v2
        (id,workspace_id,request_id,operation_key,access_class,balance_state,available_points,reserved_points,quoted_points,access_revision,rate_card_version,allowed,code,next_actions,evidence,decided_at)
       VALUES ($1,$2,$3,'payment.grant.commit','RECOVERY_CONTROL','known',$4,$5,NULL,$6,NULL,true,'OK','[]'::jsonb,$7::jsonb,$8::timestamptz)`,
      [`cad_${randomUUID()}`, workspaceId, requestId, available, reserved, revision, JSON.stringify({ simulated: false, evidence_type: 'verified_payment_event' }), decidedAt],
    )
  }
}
