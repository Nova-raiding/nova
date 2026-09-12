import { createHash } from 'node:crypto'
import type {
  FinanceAccessRole,
  FinanceRecordDetail,
  FinanceRecordKind,
  FinanceSearchPage,
  FinanceSearchQuery,
  FinanceSearchRecord,
  FinanceSearchSummary,
} from '@merchant-marketing/contracts'
import type { SqlClient, SqlPool } from './repository.js'
import { withWorkspaceTransaction } from './repository.js'

export type FinanceSearchAccess =
  | { role: 'platform_ops' }
  | { role: 'finance'; authorizedWorkspaceIds: readonly string[] }

export class FinanceSearchAccessError extends Error {
  readonly code = 'FINANCE_SEARCH_FORBIDDEN'
  constructor(message = 'finance search scope is not authorized') { super(message); this.name = 'FinanceSearchAccessError' }
}

export class FinanceSearchCursorError extends Error {
  readonly code = 'FINANCE_SEARCH_CURSOR_INVALID'
  constructor(message = 'finance search cursor is invalid') { super(message); this.name = 'FinanceSearchCursorError' }
}

export class FinanceRecordVersionConflictError extends Error {
  readonly code = 'FINANCE_RECORD_VERSION_CONFLICT'
  constructor() { super('finance record changed after the search result was loaded'); this.name = 'FinanceRecordVersionConflictError' }
}

// The platform overview is a cross-tenant operating surface. Keep a bounded
// upper limit, but do not make a healthy tenant directory of 1,222 workspaces
// look like a finance permission failure merely because the overview asks for
// an aggregate summary without a workspace filter.
const MAX_PLATFORM_WORKSPACES = 10_000
const SEARCH_CONCURRENCY = 8
const kindCounts = (): Record<FinanceRecordKind, number> => ({
  recharge_order: 0,
  wallet_transaction: 0,
  subscription_order: 0,
  usage_entry: 0,
  model_usage: 0,
})

const emptySummary = (): FinanceSearchSummary => ({
  totalRecords: 0,
  rechargeOrderCny: 0,
  fixtureRechargeOrderCny: 0,
  verifiedRechargeOrderCny: 0,
  subscriptionOrderCny: 0,
  subscriptionOrderWorkspaceCount: 0,
  subscriptionOrderBySku: {},
  commercialOrderBySku: {},
  pointPackOrderCny: 0,
  pointPackOrderCount: 0,
  pointPackOrderWorkspaceCount: 0,
  onboardingOrderCny: 0,
  onboardingOrderCount: 0,
  onboardingOrderWorkspaceCount: 0,
  walletCreditCny: 0,
  walletDebitCny: 0,
  walletNetCny: 0,
  providerCostCny: 0,
  customerChargeCny: 0,
  usageUnits: 0,
  byKind: kindCounts(),
})

type FinanceRow = {
  record_id: string
  kind: FinanceRecordKind
  sort_rank: number | string
  enterprise_name: string | null
  workspace_id: string
  status: string
  label: string
  reference: string | null
  amount_cny: number | string | null
  direction: 'credit' | 'debit' | null
  provider_cost_cny: number | string | null
  customer_charge_cny: number | string | null
  units: number | string | null
  occurred_at: string | Date
  updated_at: string | Date
  attribute_name: string | null
  attribute_value: string | null
  safe_attributes: unknown
}

type SummaryRow = {
  total_records: number | string
  recharge_order_cny: number | string
  fixture_recharge_order_cny: number | string
  verified_recharge_order_cny: number | string
  subscription_order_cny: number | string
  wallet_credit_cny: number | string
  wallet_debit_cny: number | string
  provider_cost_cny: number | string
  customer_charge_cny: number | string
  usage_units: number | string
  recharge_order_count: number | string
  wallet_transaction_count: number | string
  subscription_order_count: number | string
  subscription_order_workspace_count: number | string
  subscription_order_by_sku: unknown
  commercial_order_by_sku: unknown
  point_pack_order_cny: number | string
  point_pack_order_count: number | string
  point_pack_order_workspace_count: number | string
  onboarding_order_cny: number | string
  onboarding_order_count: number | string
  onboarding_order_workspace_count: number | string
  usage_entry_count: number | string
  model_usage_count: number | string
  missing_cost_evidence_count: number | string
}

type CursorPayload = {
  v: 1
  fingerprint: string
  snapshotAt: string
  occurredAt: string
  sortRank: number
  workspaceId: string
  recordId: string
}

const FINANCE_RECORDS_CTE = `WITH finance_records AS (
  SELECT id AS record_id, 'recharge_order'::text AS kind, 50 AS sort_rank, workspace_id,
         state AS status, '充值订单'::text AS label, channel AS reference,
         amount_fen::numeric / 100 AS amount_cny, NULL::text AS direction,
         NULL::numeric AS provider_cost_cny, NULL::numeric AS customer_charge_cny,
         NULL::bigint AS units, created_at AS occurred_at, updated_at,
         '支付渠道'::text AS attribute_name, channel AS attribute_value,
         jsonb_strip_nulls(jsonb_build_object('channel', channel, 'payment_mode', payment_mode, 'created_by_actor_id', created_by_actor_id)) AS safe_attributes,
         NULL::text AS subscription_sku_code,
         NULL::text AS commercial_kind,
         concat_ws(' ', id, workspace_id, channel, state, created_by_actor_id) AS search_text
    FROM billing_orders WHERE workspace_id = $1
  UNION ALL
  SELECT id, 'wallet_transaction', 40, workspace_id, type, '钱包流水', order_id,
         amount_fen::numeric / 100,
         CASE WHEN type = 'debit' THEN 'debit' ELSE 'credit' END,
         NULL::numeric, NULL::numeric, NULL::bigint, created_at, created_at,
         '流水类型', type,
         jsonb_strip_nulls(jsonb_build_object('transaction_type', type, 'actor_id', actor_id, 'order_id', order_id)) AS safe_attributes,
         NULL::text,
         NULL::text,
         concat_ws(' ', id, workspace_id, type, order_id, actor_id)
    FROM billing_transactions WHERE workspace_id = $1
  UNION ALL
  SELECT id::text, 'subscription_order', 30, workspace_id, status, '订阅订单', order_no,
         payment_amount_cny, NULL::text, NULL::numeric, NULL::numeric, NULL::bigint,
         created_at, COALESCE(paid_at, created_at), '套餐', plan_code,
         jsonb_strip_nulls(jsonb_build_object('plan_code', plan_code, 'billing_cycle', billing_cycle, 'payment_provider', payment_provider, 'created_by_actor_id', created_by_actor_id)) AS safe_attributes,
         plan_code,
         'monthly'::text,
         concat_ws(' ', id::text, workspace_id, order_no, plan_code, plan_name, status, payment_provider, created_by_actor_id)
    FROM workspace_subscription_orders WHERE workspace_id = $1
  UNION ALL
  SELECT o.id::text, 'subscription_order', 30, o.workspace_id,
         CASE WHEN o.status = 'paid' AND EXISTS (
           SELECT 1 FROM commercial_payment_events_v2 p
            WHERE p.order_id = o.id AND p.workspace_id = o.workspace_id AND p.verified = true
         ) THEN 'paid' ELSE o.status END,
         CASE WHEN s.kind = 'point_pack' THEN '创意点包订单'
              WHEN s.kind = 'onboarding' THEN '开通服务订单'
              ELSE '商业化月度订单' END,
         COALESCE(o.provider_order_id, o.id::text), o.amount_fen::numeric / 100,
         NULL::text, NULL::numeric, NULL::numeric, NULL::bigint,
         o.created_at, COALESCE(o.paid_at, o.created_at), 'SKU'::text, s.code,
         jsonb_strip_nulls(jsonb_build_object('sku_code', s.code, 'sku_version_id', o.sku_version_id, 'payment_provider', o.payment_provider, 'created_by_actor_id', o.created_by_actor_id)) AS safe_attributes,
         s.code,
         s.kind,
         concat_ws(' ', o.id::text, o.workspace_id, s.code, o.status, o.payment_provider, o.created_by_actor_id)
    FROM commercial_orders_v2 o
    JOIN commercial_catalog_skus s ON s.id = o.sku_id
   WHERE o.workspace_id = $1
  UNION ALL
  SELECT id::text, 'usage_entry', 20, workspace_id,
         CASE WHEN refunded THEN 'refunded' ELSE 'consumed' END, '任务额度流水', task_id,
         NULL::numeric, NULL::text, NULL::numeric, NULL::numeric, units,
         created_at, COALESCE(refunded_at, created_at), '退款状态', refunded::text,
         jsonb_strip_nulls(jsonb_build_object('task_id', task_id, 'units', units, 'refunded', refunded)) AS safe_attributes,
         NULL::text,
         NULL::text,
         concat_ws(' ', id::text, workspace_id, task_id, CASE WHEN refunded THEN 'refunded' ELSE 'consumed' END)
    FROM workspace_usage_ledger WHERE workspace_id = $1
  UNION ALL
  SELECT id, 'model_usage', 10, workspace_id, settlement_status, '模型用量', action_id,
         NULL::numeric, NULL::text, cost_cny, customer_charge_cny, total_tokens,
         observed_at, COALESCE(resolved_at, observed_at), '模型', concat_ws(' / ', modality, model),
         jsonb_strip_nulls(jsonb_build_object('action_id', action_id, 'modality', modality, 'model', model, 'total_tokens', total_tokens, 'settlement_status', settlement_status, 'budget_run_key', budget_run_key)) AS safe_attributes,
         NULL::text,
         NULL::text,
         concat_ws(' ', id, workspace_id, action_id, modality, model, settlement_status)
    FROM model_usage_ledger WHERE workspace_id = $1
), finance_records_with_enterprise AS (
  SELECT finance_records.*,
         COALESCE(NULLIF(btrim(e.name), ''), '未命名企业主体') AS enterprise_name
    FROM finance_records
    JOIN workspaces w ON w.id = finance_records.workspace_id
    JOIN enterprises e ON e.id = w.enterprise_id
)`

const FILTER_SQL = `occurred_at <= $2::timestamptz
  AND updated_at <= $2::timestamptz
  AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)
  AND ($4::timestamptz IS NULL OR occurred_at <= $4::timestamptz)
  AND (cardinality($5::text[]) = 0 OR kind = ANY($5::text[]))
  AND (cardinality($6::text[]) = 0 OR status = ANY($6::text[]))
  AND ($7::text IS NULL OR position(lower($7::text) in lower(search_text)) > 0)`

const asIso = (value: string | Date) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const number = (value: number | string | null | undefined) => value === null || value === undefined ? 0 : Number(value)
type SafeAttribute = string | number | boolean | null
const isSafeAttribute = (value: unknown): value is SafeAttribute => value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
const fingerprint = (query: FinanceSearchQuery) => createHash('sha256').update(JSON.stringify({
  workspaceIds: query.workspaceIds ? [...query.workspaceIds].sort() : [],
  kinds: query.kinds ? [...query.kinds].sort() : [],
  statuses: query.statuses ? [...query.statuses].sort() : [],
  text: query.text?.toLocaleLowerCase() ?? '',
  fromAt: query.fromAt ?? '',
  toAt: query.toAt ?? '',
})).digest('hex')

const encodeCursor = (payload: CursorPayload) => Buffer.from(JSON.stringify(payload)).toString('base64url')
const decodeCursor = (raw: string, expectedFingerprint: string): CursorPayload => {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<CursorPayload>
    if (parsed.v !== 1 || parsed.fingerprint !== expectedFingerprint || !parsed.snapshotAt || !parsed.occurredAt || !Number.isInteger(parsed.sortRank) || !parsed.workspaceId || !parsed.recordId) throw new Error('shape')
    if (!Number.isFinite(Date.parse(parsed.snapshotAt)) || !Number.isFinite(Date.parse(parsed.occurredAt))) throw new Error('timestamp')
    return parsed as CursorPayload
  } catch { throw new FinanceSearchCursorError() }
}

function rowVersion(row: FinanceRow) {
  return createHash('sha256').update(`${row.kind}|${row.record_id}|${row.status}|${asIso(row.updated_at)}`).digest('hex').slice(0, 24)
}

function mapRecord(row: FinanceRow): FinanceSearchRecord {
  const reference = row.reference?.trim()
  return {
    id: row.record_id,
    kind: row.kind,
    ...(row.enterprise_name?.trim() ? { enterpriseName: row.enterprise_name.trim() } : {}),
    workspaceId: row.workspace_id,
    status: row.status,
    label: row.label,
    ...(reference ? { reference } : {}),
    ...(row.amount_cny === null ? {} : { amountCny: Number(row.amount_cny) }),
    ...(row.direction ? { direction: row.direction } : {}),
    ...(row.provider_cost_cny === null ? {} : { providerCostCny: Number(row.provider_cost_cny) }),
    ...(row.customer_charge_cny === null ? {} : { customerChargeCny: Number(row.customer_charge_cny) }),
    ...(row.units === null ? {} : { units: Number(row.units) }),
    occurredAt: asIso(row.occurred_at),
    updatedAt: asIso(row.updated_at),
    version: rowVersion(row),
    redacted: true,
  }
}

function compareRows(left: FinanceRow, right: FinanceRow) {
  return asIso(right.occurred_at).localeCompare(asIso(left.occurred_at))
    || Number(right.sort_rank) - Number(left.sort_rank)
    || right.workspace_id.localeCompare(left.workspace_id)
    || right.record_id.localeCompare(left.record_id)
}

async function withPlatformScope<T>(pool: SqlPool, work: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
    const result = await work(client)
    await client.query('COMMIT'); committed = true
    return result
  } catch (error) {
    if (!committed) try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally { client.release?.() }
}

async function mapBounded<Input, Output>(items: readonly Input[], concurrency: number, work: (item: Input) => Promise<Output>): Promise<Output[]> {
  const results = new Array<Output>(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

export interface FinanceSearchRepository {
  search(access: FinanceSearchAccess, query: FinanceSearchQuery): Promise<FinanceSearchPage>
  detail(access: FinanceSearchAccess, input: { workspaceId: string; kind: FinanceRecordKind; id: string; expectedVersion?: string; snapshotAt?: string }): Promise<FinanceRecordDetail | undefined>
  exportRows(access: FinanceSearchAccess, query: FinanceSearchQuery, maxRows?: number): Promise<{ records: FinanceSearchRecord[]; snapshotAt: string; truncated: boolean }>
}

export class PostgresFinanceSearchRepository implements FinanceSearchRepository {
  constructor(private readonly pool: SqlPool, private readonly now: () => Date = () => new Date()) {}

  private async workspaceScope(access: FinanceSearchAccess, requested?: readonly string[]) {
    const requestedSet = requested ? new Set(requested) : undefined
    if (access.role === 'finance') {
      const allowed = new Set(access.authorizedWorkspaceIds.filter(value => value.trim()))
      if (requestedSet && [...requestedSet].some(id => !allowed.has(id))) throw new FinanceSearchAccessError()
      return [...(requestedSet ?? allowed)].sort()
    }
    return withPlatformScope(this.pool, async client => {
      const values = requestedSet ? [[...requestedSet], MAX_PLATFORM_WORKSPACES + 1] : [MAX_PLATFORM_WORKSPACES + 1]
      const result = await client.query<{ id: string }>(requestedSet
        ? 'SELECT id FROM workspaces WHERE id = ANY($1::text[]) ORDER BY id LIMIT $2'
        : 'SELECT id FROM workspaces ORDER BY id LIMIT $1', values)
      if (!requestedSet && result.rows.length > MAX_PLATFORM_WORKSPACES) throw new FinanceSearchAccessError(`platform finance search requires a workspace filter above ${MAX_PLATFORM_WORKSPACES} workspaces`)
      return result.rows.map(row => row.id)
    })
  }

  private async searchInternal(access: FinanceSearchAccess, query: FinanceSearchQuery, includeSummary: boolean): Promise<FinanceSearchPage> {
    const scope = await this.workspaceScope(access, query.workspaceIds)
    const queryFingerprint = fingerprint(query)
    const decoded = query.cursor ? decodeCursor(query.cursor, queryFingerprint) : undefined
    const snapshotAt = decoded?.snapshotAt ?? query.snapshotAt ?? this.now().toISOString()
    if (query.snapshotAt && decoded && query.snapshotAt !== decoded.snapshotAt) throw new FinanceSearchCursorError('cursor snapshot does not match the request')
    const common = [snapshotAt, query.fromAt ?? null, query.toAt ?? null, query.kinds ?? [], query.statuses ?? [], query.text ?? null]
    const perWorkspace = await mapBounded(scope, SEARCH_CONCURRENCY, workspaceId => withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const values: unknown[] = [workspaceId, ...common]
      let cursorClause = ''
      if (decoded) {
        values.push(decoded.occurredAt, decoded.sortRank, decoded.workspaceId, decoded.recordId)
        cursorClause = `AND (occurred_at, sort_rank, workspace_id, record_id) < ($8::timestamptz, $9::integer, $10::text, $11::text)`
      }
      values.push(query.limit + 1)
      const limitIndex = values.length
      const rows = await client.query<FinanceRow>(`${FINANCE_RECORDS_CTE}
        SELECT record_id, kind, sort_rank, enterprise_name, workspace_id, status, label, reference, amount_cny, direction,
               provider_cost_cny, customer_charge_cny, units, occurred_at, updated_at, attribute_name, attribute_value, safe_attributes
          FROM finance_records_with_enterprise WHERE ${FILTER_SQL} ${cursorClause}
         ORDER BY occurred_at DESC, sort_rank DESC, workspace_id DESC, record_id DESC LIMIT $${limitIndex}`, values)
      if (!includeSummary) return { rows: rows.rows, summary: undefined }
      const summary = await client.query<SummaryRow>(`${FINANCE_RECORDS_CTE}
        SELECT count(*) AS total_records,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='recharge_order' AND status='paid'),0) AS recharge_order_cny,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='recharge_order' AND status='paid' AND safe_attributes->>'payment_mode' = 'fixture'),0) AS fixture_recharge_order_cny,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='recharge_order' AND status='paid' AND COALESCE(safe_attributes->>'payment_mode', '') <> 'fixture'),0) AS verified_recharge_order_cny,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='subscription_order' AND commercial_kind='monthly' AND status='paid'),0) AS subscription_order_cny,
          count(DISTINCT workspace_id) FILTER (WHERE kind='subscription_order' AND commercial_kind='monthly' AND status='paid') AS subscription_order_workspace_count,
          COALESCE((
            SELECT jsonb_object_agg(by_sku.subscription_sku_code, jsonb_build_object('orderCount', by_sku.order_count, 'workspaceCount', by_sku.workspace_count))
              FROM (
                SELECT subscription_sku_code, count(*) AS order_count, count(DISTINCT workspace_id) AS workspace_count
                  FROM finance_records_with_enterprise
                 WHERE ${FILTER_SQL} AND kind='subscription_order' AND commercial_kind='monthly' AND status='paid' AND subscription_sku_code IS NOT NULL
                 GROUP BY subscription_sku_code
              ) by_sku
          ), '{}'::jsonb) AS subscription_order_by_sku,
          COALESCE((
            SELECT jsonb_object_agg(by_sku.subscription_sku_code, jsonb_build_object('orderCount', by_sku.order_count, 'workspaceCount', by_sku.workspace_count))
              FROM (
                SELECT subscription_sku_code, count(*) AS order_count, count(DISTINCT workspace_id) AS workspace_count
                  FROM finance_records_with_enterprise
                 WHERE ${FILTER_SQL} AND kind='subscription_order' AND status='paid' AND commercial_kind IN ('monthly', 'point_pack', 'onboarding') AND subscription_sku_code IS NOT NULL
                 GROUP BY subscription_sku_code
              ) by_sku
          ), '{}'::jsonb) AS commercial_order_by_sku,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='subscription_order' AND commercial_kind='point_pack' AND status='paid'),0) AS point_pack_order_cny,
          count(*) FILTER (WHERE kind='subscription_order' AND commercial_kind='point_pack' AND status='paid') AS point_pack_order_count,
          count(DISTINCT workspace_id) FILTER (WHERE kind='subscription_order' AND commercial_kind='point_pack' AND status='paid') AS point_pack_order_workspace_count,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='subscription_order' AND commercial_kind='onboarding' AND status='paid'),0) AS onboarding_order_cny,
          count(*) FILTER (WHERE kind='subscription_order' AND commercial_kind='onboarding' AND status='paid') AS onboarding_order_count,
          count(DISTINCT workspace_id) FILTER (WHERE kind='subscription_order' AND commercial_kind='onboarding' AND status='paid') AS onboarding_order_workspace_count,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='wallet_transaction' AND direction='credit'),0) AS wallet_credit_cny,
          COALESCE(sum(amount_cny) FILTER (WHERE kind='wallet_transaction' AND direction='debit'),0) AS wallet_debit_cny,
          COALESCE(sum(provider_cost_cny),0) AS provider_cost_cny,
          count(*) FILTER (WHERE kind='model_usage' AND provider_cost_cny IS NULL) AS missing_cost_evidence_count,
          COALESCE(sum(customer_charge_cny),0) AS customer_charge_cny,
          COALESCE(sum(units) FILTER (WHERE kind='usage_entry'),0) AS usage_units,
          count(*) FILTER (WHERE kind='recharge_order') AS recharge_order_count,
          count(*) FILTER (WHERE kind='wallet_transaction') AS wallet_transaction_count,
          count(*) FILTER (WHERE kind='subscription_order') AS subscription_order_count,
          count(*) FILTER (WHERE kind='usage_entry') AS usage_entry_count,
          count(*) FILTER (WHERE kind='model_usage') AS model_usage_count
        FROM finance_records_with_enterprise WHERE ${FILTER_SQL}`, [workspaceId, ...common])
      return { rows: rows.rows, summary: summary.rows[0] }
    }))
    const merged = perWorkspace.flatMap(value => value.rows).sort(compareRows)
    const selected = merged.slice(0, query.limit)
    const last = selected.at(-1)
    const hasMore = merged.length > query.limit || perWorkspace.some(value => value.rows.length > query.limit)
    const summary = perWorkspace.reduce((total, value) => {
      const row = value.summary
      if (!row) return total
      total.totalRecords += number(row.total_records)
      total.rechargeOrderCny += number(row.recharge_order_cny)
      total.fixtureRechargeOrderCny = (total.fixtureRechargeOrderCny ?? 0) + number(row.fixture_recharge_order_cny)
      total.verifiedRechargeOrderCny = (total.verifiedRechargeOrderCny ?? 0) + number(row.verified_recharge_order_cny)
      total.subscriptionOrderCny += number(row.subscription_order_cny)
      total.subscriptionOrderWorkspaceCount += number(row.subscription_order_workspace_count)
      if (row.subscription_order_by_sku && typeof row.subscription_order_by_sku === 'object' && !Array.isArray(row.subscription_order_by_sku)) {
        for (const [sku, value] of Object.entries(row.subscription_order_by_sku as Record<string, unknown>)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          const item = value as { orderCount?: unknown; workspaceCount?: unknown }
          const current = total.subscriptionOrderBySku[sku] ?? { orderCount: 0, workspaceCount: 0 }
          current.orderCount += number(item.orderCount as number | string | null | undefined)
          current.workspaceCount += number(item.workspaceCount as number | string | null | undefined)
          total.subscriptionOrderBySku[sku] = current
        }
      }
      if (row.commercial_order_by_sku && typeof row.commercial_order_by_sku === 'object' && !Array.isArray(row.commercial_order_by_sku)) {
        for (const [sku, value] of Object.entries(row.commercial_order_by_sku as Record<string, unknown>)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          const item = value as { orderCount?: unknown; workspaceCount?: unknown }
          const current = total.commercialOrderBySku?.[sku] ?? { orderCount: 0, workspaceCount: 0 }
          current.orderCount += number(item.orderCount as number | string | null | undefined)
          current.workspaceCount += number(item.workspaceCount as number | string | null | undefined)
          total.commercialOrderBySku = { ...(total.commercialOrderBySku ?? {}), [sku]: current }
        }
      }
      total.pointPackOrderCny = (total.pointPackOrderCny ?? 0) + number(row.point_pack_order_cny)
      total.pointPackOrderCount = (total.pointPackOrderCount ?? 0) + number(row.point_pack_order_count)
      total.pointPackOrderWorkspaceCount = (total.pointPackOrderWorkspaceCount ?? 0) + number(row.point_pack_order_workspace_count)
      total.onboardingOrderCny = (total.onboardingOrderCny ?? 0) + number(row.onboarding_order_cny)
      total.onboardingOrderCount = (total.onboardingOrderCount ?? 0) + number(row.onboarding_order_count)
      total.onboardingOrderWorkspaceCount = (total.onboardingOrderWorkspaceCount ?? 0) + number(row.onboarding_order_workspace_count)
      total.walletCreditCny += number(row.wallet_credit_cny)
      total.walletDebitCny += number(row.wallet_debit_cny)
      total.providerCostCny = (total.providerCostCny ?? 0) + number(row.provider_cost_cny)
      total.missingCostEvidenceCount = (total.missingCostEvidenceCount ?? 0) + number(row.missing_cost_evidence_count)
      total.customerChargeCny += number(row.customer_charge_cny)
      total.usageUnits += number(row.usage_units)
      total.byKind.recharge_order += number(row.recharge_order_count)
      total.byKind.wallet_transaction += number(row.wallet_transaction_count)
      total.byKind.subscription_order += number(row.subscription_order_count)
      total.byKind.usage_entry += number(row.usage_entry_count)
      total.byKind.model_usage += number(row.model_usage_count)
      return total
    }, emptySummary())
    totalMoney(summary)
    summary.providerCostStatus = summary.missingCostEvidenceCount && summary.missingCostEvidenceCount > 0 ? 'partial' : 'verified'
    // This repository only reads the tenant finance projection; it does not
    // contain the external Provider statement. Never infer reconciliation from
    // a populated local cost column.
    summary.providerStatementStatus = 'not_checked'
    if (summary.providerCostStatus !== 'verified') summary.providerCostCny = null
    return {
      records: selected.map(mapRecord), summary,
      ...(hasMore && last ? { nextCursor: encodeCursor({ v: 1, fingerprint: queryFingerprint, snapshotAt, occurredAt: asIso(last.occurred_at), sortRank: Number(last.sort_rank), workspaceId: last.workspace_id, recordId: last.record_id }) } : {}),
      snapshotAt,
      scope: { role: access.role as FinanceAccessRole, workspaceCount: scope.length },
    }
  }

  async search(access: FinanceSearchAccess, query: FinanceSearchQuery) { return this.searchInternal(access, query, true) }

  async detail(access: FinanceSearchAccess, input: { workspaceId: string; kind: FinanceRecordKind; id: string; expectedVersion?: string; snapshotAt?: string }) {
    const scope = await this.workspaceScope(access, [input.workspaceId])
    if (!scope.includes(input.workspaceId)) return undefined
    const snapshotAt = input.snapshotAt ?? this.now().toISOString()
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<FinanceRow>(`${FINANCE_RECORDS_CTE}
        SELECT record_id, kind, sort_rank, enterprise_name, workspace_id, status, label, reference, amount_cny, direction,
               provider_cost_cny, customer_charge_cny, units, occurred_at, updated_at, attribute_name, attribute_value, safe_attributes
          FROM finance_records_with_enterprise
         WHERE kind=$3 AND record_id=$4 AND occurred_at <= $2::timestamptz LIMIT 1`, [input.workspaceId, snapshotAt, input.kind, input.id])
      const row = result.rows[0]
      if (!row) return undefined
      const record = mapRecord(row)
      if (input.expectedVersion && input.expectedVersion !== record.version) throw new FinanceRecordVersionConflictError()
      const safeAttributes: Record<string, SafeAttribute> = row.safe_attributes && typeof row.safe_attributes === 'object' && !Array.isArray(row.safe_attributes)
        ? Object.fromEntries(Object.entries(row.safe_attributes as Record<string, unknown>).filter(([, value]) => isSafeAttribute(value))) as Record<string, SafeAttribute>
        : {}
      return { ...record, attributes: Object.freeze(Object.keys(safeAttributes).length > 0 ? safeAttributes : row.attribute_name ? { [row.attribute_name]: row.attribute_value } : {}) }
    })
  }

  async exportRows(access: FinanceSearchAccess, query: FinanceSearchQuery, maxRows = 5_000) {
    const bounded = Math.min(5_000, Math.max(1, Math.trunc(maxRows)))
    const records: FinanceSearchRecord[] = []
    let cursor = query.cursor
    let snapshotAt = query.snapshotAt
    let truncated = false
    while (records.length < bounded) {
      const page = await this.searchInternal(access, { ...query, cursor, snapshotAt, limit: Math.min(100, bounded - records.length) }, false)
      records.push(...page.records)
      snapshotAt = page.snapshotAt
      cursor = page.nextCursor
      if (!cursor) break
      if (records.length >= bounded) truncated = true
    }
    return { records, snapshotAt: snapshotAt ?? this.now().toISOString(), truncated }
  }
}

function totalMoney(summary: FinanceSearchSummary) {
  const round = (value: number) => Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
  summary.rechargeOrderCny = round(summary.rechargeOrderCny)
  summary.fixtureRechargeOrderCny = round(summary.fixtureRechargeOrderCny ?? 0)
  summary.verifiedRechargeOrderCny = round(summary.verifiedRechargeOrderCny ?? 0)
  summary.subscriptionOrderCny = round(summary.subscriptionOrderCny)
  summary.pointPackOrderCny = round(summary.pointPackOrderCny ?? 0)
  summary.onboardingOrderCny = round(summary.onboardingOrderCny ?? 0)
  summary.walletCreditCny = round(summary.walletCreditCny)
  summary.walletDebitCny = round(summary.walletDebitCny)
  summary.walletNetCny = round(summary.walletCreditCny - summary.walletDebitCny)
  summary.providerCostCny = round(summary.providerCostCny ?? 0)
  summary.customerChargeCny = round(summary.customerChargeCny)
}
