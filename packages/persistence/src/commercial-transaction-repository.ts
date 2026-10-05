import { createHash, randomUUID } from 'node:crypto'
import { assertSupportedCommercialCycleGrantPolicy, calculateCommercialUpgrade, type CommercialUpgradeCalculation, type CommercialUpgradeCarry } from '@merchant-marketing/application/commercial-upgrade-policy'
import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { COMMERCIAL_BENEFIT_DEFINITIONS } from './commercial-benefit-definitions.js'
import { CommercialContractError, assertVerifiedLegacyOrderSnapshot, monthlyAnniversary, commercialOnboardingGrantSchedule, type CommercialEntitlementSnapshotV2, type CommercialOrderV2, type CreateCommercialOrderInput, type VerifiedPaymentGrantInput, type PaymentGrantResult } from './commercial-contract-repository.js'
import {CommercialSchemaCompatibilityError,hasCommercialRelationForVerifiedPrefix} from './commercial-schema-compatibility.js'
import { assertCommercialNewPlanNotLower,CommercialPlanChangePolicyError,commercialCycle, commercialPaymentIsTimely, commercialPlanIdentity, commercialPurchasePolicy, type CommercialGrantStatusV3, type CommercialOrderTermsV3 } from './commercial-transaction-policy.js'
import { requireWorkspaceScope, withWorkspaceTransaction, type SqlClient, type SqlPool } from './repository.js'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const iso = (value: string | Date): string => { const date = new Date(value); if (!Number.isFinite(date.valueOf())) throw new TypeError('invalid timestamp'); return date.toISOString() }
const id = (prefix: string): string => `${prefix}_${randomUUID()}`
const integer = (value: unknown): number => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'invalid integer'); return n }
const projection = `o.id,o.workspace_id AS "workspaceId",o.sku_id AS "skuId",o.sku_version_id AS "skuVersionId",o.amount_fen AS "amountFen",o.currency,o.payment_provider AS "paymentProvider",o.status,o.idempotency_key AS "idempotencyKey",o.request_hash AS "requestHash",o.created_by_actor_id AS "createdByActorId",o.provider_order_id AS "providerOrderId",o.checkout_url AS "checkoutUrl",o.checkout_expires_at AS "checkoutExpiresAt",o.checkout_idempotency_key AS "checkoutIdempotencyKey",o.created_at AS "createdAt",o.paid_at AS "paidAt"`
const termsProjection = `t.purchase_kind AS "purchaseKind",t.expires_at AS "expiresAt",t.policy_version AS "policyVersion",t.checkout_id AS "checkoutId",t.onboarding_order_id AS "onboardingOrderId",t.upgrade_quote_id AS "upgradeQuoteId",t.beneficiary_member_id AS "beneficiaryMemberId",t.grant_status AS "grantStatus"`
type OrderFact = CommercialOrderV2 & CommercialOrderTermsV3 & { snapshotId: string; snapshot: { sku: CommercialCatalogSkuSnapshot; purchase_terms?: CommercialOrderTermsV3 } }
const mapOrder = (row: CommercialOrderV2): CommercialOrderV2 => ({ ...row, amountFen: integer(row.amountFen), createdAt: iso(row.createdAt), paidAt: row.paidAt ? iso(row.paidAt) : null, expiresAt: row.expiresAt ? iso(row.expiresAt) : null, checkoutExpiresAt: row.checkoutExpiresAt ? iso(row.checkoutExpiresAt) : null })

export interface CommercialUpgradeQuoteV3 extends CommercialUpgradeCalculation {
  id: string
  workspaceId: string
  sourceOrderId: string
  sourcePeriodId: string
  sourcePeriodRevision: number
  sourceEntitlementId: string
  sourceSkuCode: string
  targetSkuCode: string
  targetSkuVersionId: string
  currentCyclePriceFen: number
  targetCyclePriceFen: number
  currency: 'CNY'
  expiresAt: string
  resolvedTargetBenefits: CommercialCatalogSkuSnapshot['benefits']
  actorId: string
  sourceSnapshot: CommercialCatalogSkuSnapshot
  targetSnapshot?: CommercialCatalogSkuSnapshot
  sourceUpgradeQuote?: CommercialUpgradeQuoteV3
}
type CurrentPeriod = { periodId: string; revision: number; periodStart: string; periodEnd: string; sourceOrderId: string; entitlementId: string; sku: CommercialCatalogSkuSnapshot; resolvedBenefits: CommercialCatalogSkuSnapshot['benefits']; upgradeQuote?: CommercialUpgradeQuoteV3 }

async function workspaceLock(client: SqlClient, workspaceId: string): Promise<void> {
  await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))`, ['workspace_subscription_periods_v2', workspaceId])
}
async function balance(client: SqlClient, workspaceId: string) {
  const result = await client.query<{ available: number; reserved: number; settled: number; revision: number }>(`SELECT available_points AS available,reserved_points AS reserved,settled_points AS settled,revision FROM creative_point_access_state WHERE workspace_id=$1`, [workspaceId])
  const row = result.rows[0]
  return { available: integer(row?.available ?? 0), reserved: integer(row?.reserved ?? 0), settled: integer(row?.settled ?? 0), revision: integer(row?.revision ?? 0) }
}
function cycleEnd(sku: CommercialCatalogSkuSnapshot, start: string): string {
  const cycle = commercialCycle(sku)
  return cycle.unit === 'month' ? monthlyAnniversary(start, cycle.count) : new Date(Date.parse(start) + cycle.count * 86400000).toISOString()
}
function approved(sku: CommercialCatalogSkuSnapshot, now: string): void {
  if (sku.lifecycle !== 'approved' || !sku.executable || !sku.effectiveAt || Date.parse(sku.effectiveAt) > Date.parse(now)
    || sku.currency !== 'CNY' || sku.priceMode !== 'fixed' || !Number.isSafeInteger(sku.priceFen) || Number(sku.priceFen) <= 0
    || (Array.isArray(sku.payload.blockers) && sku.payload.blockers.length)) throw new CommercialContractError('COMMERCIAL_CATALOG_UNAVAILABLE', 'approved fixed-price sale unavailable')
  if (sku.kind === 'monthly') {
    try { assertSupportedCommercialCycleGrantPolicy({ cycle: sku.payload.cycle, pointGrantPolicy: sku.payload.pointGrantPolicy }) }
    catch { throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'approved supported cycle and point-grant cadence required') }
  }
}
async function resolveSale(client: SqlClient, code: string, capabilities: string[] = []): Promise<CommercialCatalogSkuSnapshot> {
  const result = await client.query<{ snapshot: CommercialCatalogSkuSnapshot | null }>(`SELECT public.merchant_resolve_sale_sku_v3($1,false,$2::text[]) AS snapshot`, [code, capabilities])
  if (!result.rows[0]?.snapshot) throw new CommercialContractError('COMMERCIAL_CATALOG_UNAVAILABLE', 'SKU is not currently for sale')
  return result.rows[0].snapshot
}
async function currentPeriod(client: SqlClient, workspaceId: string, now: string): Promise<CurrentPeriod | null> {
  const result = await client.query<CurrentPeriod>(`SELECT p.id AS "periodId",p.revision,p.period_start AS "periodStart",p.period_end AS "periodEnd",o.id AS "sourceOrderId",e.id AS "entitlementId",
      COALESCE(u.target_snapshot,h.restored_snapshot,s.snapshot->'sku') AS sku,COALESCE(u.quote,h.restored_quote) AS "upgradeQuote",e.resolved_benefits AS "resolvedBenefits"
    FROM workspace_subscription_periods_v2 p
    JOIN commercial_order_snapshots_v2 s ON s.workspace_id=p.workspace_id AND s.id=p.order_snapshot_id
    JOIN commercial_orders_v2 o ON o.workspace_id=s.workspace_id AND o.id=s.order_id
    JOIN workspace_entitlement_snapshots_v2 e ON e.workspace_id=p.workspace_id AND e.subscription_period_id=p.id AND e.subscription_period_revision=p.revision
    LEFT JOIN commercial_upgrade_events_v3 u ON u.workspace_id=p.workspace_id AND u.period_id=p.id AND u.to_revision=p.revision
    LEFT JOIN commercial_source_recovery_holds_v3 h ON h.workspace_id=p.workspace_id AND h.restored_period_id=p.id AND h.restored_revision=p.revision AND h.state='completed'
    WHERE p.workspace_id=$1 AND p.status='active' AND p.period_start<=$2::timestamptz AND p.period_end>$2::timestamptz AND o.status='paid' AND e.executable
    ORDER BY p.id LIMIT 2`, [workspaceId, now])
  if (result.rows.length > 1) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'multiple current contract periods')
  const row = result.rows[0]
  return row ? { ...row, revision: integer(row.revision), periodStart: iso(row.periodStart), periodEnd: iso(row.periodEnd) } : null
}

async function paidContractPlans(client:SqlClient,workspaceId:string,at:string):Promise<CommercialCatalogSkuSnapshot[]> {
  const result=await client.query<{sku:CommercialCatalogSkuSnapshot;executable:boolean;unresolvedBlockers:unknown}>(`SELECT COALESCE(u.target_snapshot,h.restored_snapshot,s.snapshot->'sku') AS sku,e.executable,e.unresolved_blockers AS "unresolvedBlockers"
    FROM workspace_subscription_periods_v2 p
    JOIN commercial_order_snapshots_v2 s ON s.workspace_id=p.workspace_id AND s.id=p.order_snapshot_id
    JOIN commercial_orders_v2 o ON o.workspace_id=s.workspace_id AND o.id=s.order_id
    LEFT JOIN workspace_entitlement_snapshots_v2 e ON e.workspace_id=p.workspace_id AND e.subscription_period_id=p.id AND e.subscription_period_revision=p.revision
    LEFT JOIN commercial_upgrade_events_v3 u ON u.workspace_id=p.workspace_id AND u.period_id=p.id AND u.to_revision=p.revision
    LEFT JOIN commercial_source_recovery_holds_v3 h ON h.workspace_id=p.workspace_id AND h.restored_period_id=p.id AND h.restored_revision=p.revision AND h.state='completed'
    WHERE p.workspace_id=$1 AND p.status='active' AND p.period_end>$2::timestamptz AND o.status='paid' ORDER BY p.period_start,p.id`,[workspaceId,at])
  if(result.rows.some(row=>!row.sku||row.sku.kind!=='monthly'||!row.executable||!Array.isArray(row.unresolvedBlockers)||row.unresolvedBlockers.length))throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','paid future contract identity is unavailable')
  for (const row of result.rows) {
    try { assertSupportedCommercialCycleGrantPolicy({ cycle: row.sku.payload.cycle, pointGrantPolicy: row.sku.payload.pointGrantPolicy }) }
    catch { throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'paid future contract cycle is unsupported for new orders') }
  }
  return result.rows.map(row=>row.sku)
}
function requireNewPlanNotLower(target:CommercialCatalogSkuSnapshot,existing:readonly CommercialCatalogSkuSnapshot[]):void {
  try {assertCommercialNewPlanNotLower(target,existing)}
  catch(error){if(error instanceof CommercialPlanChangePolicyError)throw new CommercialContractError(error.code,error.message);throw error}
}

/** All v3 public purchase callers use this unit of work. No client amount or
 * externally supplied snapshot can authorize a sale; the SQL function locks
 * the real projection before Workspace/order/entitlement/ledger locks. */
export class CommercialTransactionRepositoryV3 {
  constructor(private readonly pool: SqlPool) {}

  async getOnboardingStatus(workspaceId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const status = await this.onboardingStatusInTransaction(client, scope)
      if (status.qualified) return status
      const exceptions = await client.query<{ orderId: string; startsAt: string; expiresAt: string; policyId: string }>(`SELECT o.id AS "orderId",p.period_start AS "startsAt",p.period_end AS "expiresAt",s.sku_version_id AS "policyId" FROM workspace_subscription_periods_v2 p JOIN commercial_order_snapshots_v2 s ON s.workspace_id=p.workspace_id AND s.id=p.order_snapshot_id JOIN commercial_orders_v2 o ON o.workspace_id=s.workspace_id AND o.id=s.order_id JOIN private_trial_eligibilities_v2 e ON e.workspace_id=s.workspace_id AND e.id=s.snapshot->>'private_eligibility_id' WHERE p.workspace_id=$1 AND p.status='active' AND p.period_start<=now() AND p.period_end>now() AND o.status='paid' AND s.snapshot->'sku'->>'kind'='private_trial' AND e.status IN ('approved','approved_pending_validation') AND e.expires_at>now() AND e.approved_by_actor_id IS NOT NULL AND e.evidence<>'{}'::jsonb LIMIT 2`, [scope])
      if (exceptions.rows.length !== 1) return status
      const exception = exceptions.rows[0]!
      return { ...status, approved_private_trial_exception: { workspace_id: scope, starts_at: iso(exception.startsAt), expires_at: iso(exception.expiresAt), policy_id: exception.policyId, order_id: exception.orderId } }
    })
  }

  async onboardingStatusInTransaction(client: SqlClient, workspaceId: string) {
    const result = await client.query<{ status: string; orderId: string | null; activatedAt: string | null }>(`SELECT status,onboarding_order_id AS "orderId",activated_at AS "activatedAt" FROM workspace_commercial_onboarding_v3 WHERE workspace_id=$1`, [workspaceId])
    const row = result.rows[0]
    return { qualified: row?.status === 'active', status: row?.status ?? 'not_opened', orderId: row?.orderId ?? null, activatedAt: row?.activatedAt ? iso(row.activatedAt) : null }
  }

  async createUpgradeQuote(input: { workspaceId: string; actorId: string; targetSkuCode: string; idempotencyKey: string; now?: string; saleCapabilities?: string[] }): Promise<CommercialUpgradeQuoteV3> {
    const workspaceId = requireWorkspaceScope(input.workspaceId), at = iso(input.now ?? new Date())
    if (!input.actorId || !input.targetSkuCode || !input.idempotencyKey) throw new TypeError('actor, SKU and idempotency key required')
    const requestHash = hash({ targetSkuCode: input.targetSkuCode, actorId: input.actorId })
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const prior = await client.query<{ quote: CommercialUpgradeQuoteV3; requestHash: string }>(`SELECT quote,request_hash AS "requestHash" FROM commercial_upgrade_quotes_v3 WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, input.idempotencyKey])
      if (prior.rows[0]) { if (prior.rows[0].requestHash !== requestHash) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'quote key reused'); return prior.rows[0].quote }
      const target = await resolveSale(client, input.targetSkuCode, input.saleCapabilities)
      approved(target, at)
      await workspaceLock(client, workspaceId)
      const repeated = await client.query<{ quote: CommercialUpgradeQuoteV3; requestHash: string }>(`SELECT quote,request_hash AS "requestHash" FROM commercial_upgrade_quotes_v3 WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, input.idempotencyKey])
      if (repeated.rows[0]) { if (repeated.rows[0].requestHash !== requestHash) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'quote key reused'); return repeated.rows[0].quote }
      if (!(await this.onboardingStatusInTransaction(client, workspaceId)).qualified) throw new CommercialContractError('COMMERCIAL_ONBOARDING_REQUIRED', 'verified onboarding required')
      const source = await currentPeriod(client, workspaceId, at)
      if (!source || source.sku.kind !== 'monthly' || target.kind !== 'monthly') throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'upgrade requires a current monthly contract')
      try { assertSupportedCommercialCycleGrantPolicy({ cycle: source.sku.payload.cycle, pointGrantPolicy: source.sku.payload.pointGrantPolicy }) }
      catch { throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'current contract cycle is unsupported for upgrade') }
      requireNewPlanNotLower(target,[source.sku])
      const upgradePolicy = target.payload.upgradePolicy as Record<string, unknown> | undefined
      if (upgradePolicy?.approved !== true || typeof upgradePolicy.version !== 'string') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'upgrade policy approval required')
      const purchasePolicy = commercialPurchasePolicy(target), sourceIdentity = commercialPlanIdentity(source.sku), targetIdentity = commercialPlanIdentity(target)
      const sourceCycleGrant = assertSupportedCommercialCycleGrantPolicy({ cycle: source.sku.payload.cycle, pointGrantPolicy: source.sku.payload.pointGrantPolicy })
      const targetCycleGrant = assertSupportedCommercialCycleGrantPolicy({ cycle: target.payload.cycle, pointGrantPolicy: target.payload.pointGrantPolicy })
      const sourceCycleKey = JSON.stringify(sourceCycleGrant), targetCycleKey = JSON.stringify(targetCycleGrant)
      const definitions = COMMERCIAL_BENEFIT_DEFINITIONS.filter(d => d.upgradeSemantics !== 'none').map(d => ({ code: d.code, unit: d.unit, kind: d.upgradeSemantics === 'contract' ? 'lower_is_better' as const : d.upgradeSemantics }))
      const relevant = new Set(definitions.map(d => d.code))
      const carry: Record<string, CommercialUpgradeCarry> = {}
      for (const increment of source.upgradeQuote?.benefitIncrements ?? []) if (increment.carry) carry[increment.code] = increment.carry
      const calculation = calculateCommercialUpgrade({
        source: { ...sourceIdentity, cycleKey: sourceCycleKey, cyclePriceFen: integer(source.sku.priceFen), benefits: source.sku.benefits.filter(b => relevant.has(b.code as typeof definitions[number]['code'])) },
        target: { ...targetIdentity, cycleKey: targetCycleKey, cyclePriceFen: integer(target.priceFen), benefits: target.benefits.filter(b => relevant.has(b.code as typeof definitions[number]['code'])) },
        periodStart: source.periodStart, periodEnd: source.periodEnd, quotedAt: at, definitions, carry,
      })
      const quote: CommercialUpgradeQuoteV3 = { ...calculation, id: id('cuq'), workspaceId, actorId: input.actorId, sourceOrderId: source.sourceOrderId, sourcePeriodId: source.periodId,
        sourcePeriodRevision: source.revision, sourceEntitlementId: source.entitlementId, sourceSkuCode: source.sku.code, targetSkuCode: target.code,
        targetSkuVersionId: target.versionId, currentCyclePriceFen: integer(source.sku.priceFen), targetCyclePriceFen: integer(target.priceFen), currency: 'CNY', sourceSnapshot: source.sku, ...(source.upgradeQuote ? { sourceUpgradeQuote: source.upgradeQuote } : {}),
        expiresAt: new Date(Math.min(Date.parse(source.periodEnd), Date.parse(at) + purchasePolicy.expiresInSeconds * 1000)).toISOString(), resolvedTargetBenefits: target.benefits }
      await client.query(`INSERT INTO commercial_upgrade_quotes_v3(workspace_id,id,idempotency_key,request_hash,quote,target_snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::timestamptz,$8::timestamptz)`, [workspaceId, quote.id, input.idempotencyKey, requestHash, JSON.stringify(quote), JSON.stringify(target), at, quote.expiresAt])
      return quote
    })
  }

  async createOrder(input: CreateCommercialOrderInput): Promise<CommercialOrderV2> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, client => this.createOrderInTransaction(client, input))
  }

  async createFirstCheckout(input: { workspaceId: string; actorId: string; onboardingSku: CommercialCatalogSkuSnapshot; subscriptionSku: CommercialCatalogSkuSnapshot; expectedOnboardingSkuVersionId?: string; expectedSubscriptionSkuVersionId?: string; paymentProvider: string; idempotencyKey: string; reason: string; now?: string; saleCapabilities?: string[]; beneficiaryMemberId?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId), checkoutId = `cck_${hash({ workspaceId, key: input.idempotencyKey }).slice(0, 30)}`
    if (input.onboardingSku.kind !== 'onboarding' || input.subscriptionSku.kind !== 'monthly') throw new TypeError('first checkout requires onboarding and subscription')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      if (input.beneficiaryMemberId) {
        const member = await client.query(`SELECT id FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active' FOR KEY SHARE`,[workspaceId,input.beneficiaryMemberId])
        if (!member.rows[0]) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT','指定受益商家成员不存在或未激活')
      }
      const previous = await client.query<{ id: string }>(`SELECT order_id AS id FROM commercial_order_terms_v3 WHERE workspace_id=$1 AND checkout_id=$2`, [workspaceId,checkoutId])
      if (previous.rows.length === 2) {
        const common = { workspaceId, paymentProvider: input.paymentProvider, createdByActorId: input.actorId, checkoutId, reason: input.reason, now: input.now, beneficiaryMemberId: input.beneficiaryMemberId }
        const onboarding = await this.createOrderInTransaction(client,{...common,sku:input.onboardingSku,expectedSkuVersionId:input.expectedOnboardingSkuVersionId,purchaseKind:'onboarding_once',idempotencyKey:`${input.idempotencyKey}:onboarding`},true)
        const subscription = await this.createOrderInTransaction(client,{...common,sku:input.subscriptionSku,expectedSkuVersionId:input.expectedSubscriptionSkuVersionId,purchaseKind:'purchase',onboardingOrderId:onboarding.id,idempotencyKey:`${input.idempotencyKey}:subscription`},true)
        return {checkoutId,onboarding,subscription,amountFen:onboarding.amountFen+subscription.amountFen,currency:'CNY' as const}
      }
      if (previous.rows.length) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT','incomplete first checkout requires reconciliation')
      // Acquire every sale lock in a deterministic order before the workspace.
      const locked = new Map<string, CommercialCatalogSkuSnapshot>()
      for (const sku of [input.onboardingSku, input.subscriptionSku].sort((a, b) => a.code.localeCompare(b.code))) locked.set(sku.code, await resolveSale(client, sku.code, input.saleCapabilities))
      await workspaceLock(client, workspaceId)
      const common = { workspaceId, paymentProvider: input.paymentProvider, createdByActorId: input.actorId, checkoutId, reason: input.reason, now: input.now, saleCapabilities: input.saleCapabilities, beneficiaryMemberId: input.beneficiaryMemberId }
      const onboarding = await this.createOrderInTransaction(client, { ...common, sku: locked.get(input.onboardingSku.code)!, expectedSkuVersionId:input.expectedOnboardingSkuVersionId, purchaseKind: 'onboarding_once', idempotencyKey: `${input.idempotencyKey}:onboarding` }, true)
      const subscription = await this.createOrderInTransaction(client, { ...common, sku: locked.get(input.subscriptionSku.code)!, expectedSkuVersionId:input.expectedSubscriptionSkuVersionId, purchaseKind: 'purchase', onboardingOrderId: onboarding.id, idempotencyKey: `${input.idempotencyKey}:subscription` }, true)
      return { checkoutId, onboarding, subscription, amountFen: onboarding.amountFen + subscription.amountFen, currency: 'CNY' as const }
    })
  }

  async createOrderInTransaction(client: SqlClient, input: CreateCommercialOrderInput, salesAlreadyLocked = false): Promise<CommercialOrderV2> {
    const workspaceId = requireWorkspaceScope(input.workspaceId), at = iso(input.now ?? new Date())
    if (!input.purchaseKind || !input.idempotencyKey || !input.createdByActorId || !input.reason || !input.paymentProvider) throw new TypeError('complete server-owned purchase intent required')
    if (!['manual_transfer', 'alipay', 'wechat'].includes(input.paymentProvider)) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'approved payment mode required')
    const requestHash = hash({ skuCode: input.sku.code, purchaseKind: input.purchaseKind, paymentProvider: input.paymentProvider, actorId: input.createdByActorId, reason: input.reason, quoteId: input.upgradeQuoteId ?? null, checkoutId: input.checkoutId ?? null, dependency: input.onboardingOrderId ?? null, expectedSkuVersionId: input.expectedSkuVersionId ?? null, beneficiaryMemberId: input.beneficiaryMemberId ?? null })
    const findPrior = async () => (await client.query<CommercialOrderV2>(`SELECT ${projection},${termsProjection} FROM commercial_orders_v2 o JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id WHERE o.workspace_id=$1 AND o.idempotency_key=$2`, [workspaceId, input.idempotencyKey])).rows[0]
    const prior = await findPrior()
    if (prior) { if (prior.requestHash !== requestHash) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'purchase intent key reused'); return mapOrder(prior) }
    let sku = salesAlreadyLocked ? input.sku : await resolveSale(client, input.sku.code, input.saleCapabilities)
    approved(sku, at)
    if (input.expectedSkuVersionId && sku.versionId !== input.expectedSkuVersionId) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'sale version changed; confirm updated price and benefits')
    let policy = commercialPurchasePolicy(sku)
    await workspaceLock(client, workspaceId)
    const replay = await findPrior()
    if (replay) { if (replay.requestHash !== requestHash) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'purchase intent key reused'); return mapOrder(replay) }
    const qualification = await this.onboardingStatusInTransaction(client, workspaceId)
    if (['purchase','renewal','upgrade'].includes(input.purchaseKind)) {
      const blocked = await client.query<{id:string}>(`SELECT id FROM workspace_subscription_periods_v2 WHERE workspace_id=$1 AND status='blocked' AND period_end>$2::timestamptz LIMIT 1`,[workspaceId,at])
      if (blocked.rows[0]) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT','source recovery freezes contract changes until external settlement')
    }
    let kind = input.purchaseKind, amountFen = integer(sku.priceFen), expiresAt = new Date(Date.parse(at) + policy.expiresInSeconds * 1000).toISOString()
    if (kind === 'onboarding_once') {
      if (sku.kind !== 'onboarding') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'onboarding SKU required')
      if (qualification.qualified || qualification.status === 'blocked') throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'onboarding already active or ambiguous')
      const pending = await client.query<{ id: string }>(`SELECT o.id FROM commercial_orders_v2 o JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id WHERE o.workspace_id=$1 AND t.purchase_kind='onboarding_once' AND (o.status='pending' AND t.expires_at>$2::timestamptz OR o.status='reconciliation_required') ORDER BY o.id LIMIT 1`, [workspaceId, at])
      if (pending.rows[0]) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', `existing onboarding intent:${pending.rows[0].id}`)
    } else {
      if (!qualification.qualified) {
        const dependency = input.onboardingOrderId && input.checkoutId ? await client.query<{ id: string }>(`SELECT o.id FROM commercial_orders_v2 o JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 AND t.purchase_kind='onboarding_once' AND t.checkout_id=$3 AND o.status='pending' AND t.expires_at>$4::timestamptz`, [workspaceId, input.onboardingOrderId, input.checkoutId, at]) : null
        if (!dependency?.rows[0]) throw new CommercialContractError('COMMERCIAL_ONBOARDING_REQUIRED', 'verified onboarding or explicit first-checkout dependency required')
      }
      if (kind === 'point_pack' && sku.kind !== 'point_pack') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'point-pack SKU required')
      if (kind === 'purchase' || kind === 'renewal') {
        if (sku.kind !== 'monthly') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'monthly SKU required')
        const current = await currentPeriod(client, workspaceId, at)
        const future = await paidContractPlans(client,workspaceId,at)
        requireNewPlanNotLower(sku,[...(current?[current.sku]:[]),...future])
        if (!current && future.length) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'future paid contract prevents automatic gap insertion')
        if (current) {
          const sourceIdentity = commercialPlanIdentity(current.sku), targetIdentity = commercialPlanIdentity(sku)
          if (sourceIdentity.planFamily !== targetIdentity.planFamily || sourceIdentity.tierRank !== targetIdentity.tierRank) throw new CommercialContractError('COMMERCIAL_UPGRADE_QUOTE_REQUIRED', 'tier change requires an explicit upgrade quote')
          kind = 'renewal'
        } else if (kind === 'renewal') throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'renewal requires current contract')
      }
      if (kind === 'upgrade') {
        if (!input.upgradeQuoteId) throw new CommercialContractError('COMMERCIAL_UPGRADE_QUOTE_REQUIRED', 'frozen quote required')
        const frozen = await client.query<{ quote: CommercialUpgradeQuoteV3; target: CommercialCatalogSkuSnapshot }>(`SELECT quote,target_snapshot AS target FROM commercial_upgrade_quotes_v3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, input.upgradeQuoteId])
        const quote = frozen.rows[0]?.quote
        const current = await currentPeriod(client, workspaceId, at)
        if (!quote || Date.parse(quote.expiresAt) <= Date.parse(at) || quote.targetSkuCode !== sku.code || !current || current.periodId !== quote.sourcePeriodId || current.revision !== quote.sourcePeriodRevision || current.entitlementId !== quote.sourceEntitlementId) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'quote expired or source/target changed')
        sku = frozen.rows[0]!.target
        approved(sku, at)
        requireNewPlanNotLower(sku,[current.sku])
        policy = commercialPurchasePolicy(sku)
        amountFen = quote.amountFen
        expiresAt = quote.expiresAt
      }
    }
    const orderId = id('cor'), snapshotId = id('cos')
    if (input.beneficiaryMemberId) {
      const member = await client.query(`SELECT id FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active' FOR KEY SHARE`, [workspaceId,input.beneficiaryMemberId])
      if (!member.rows[0]) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT','指定受益商家成员不存在或未激活')
    }
    const terms: CommercialOrderTermsV3 = { purchaseKind: kind, expiresAt, policyVersion: policy.version, checkoutId: input.checkoutId ?? null, onboardingOrderId: input.onboardingOrderId ?? null, upgradeQuoteId: input.upgradeQuoteId ?? null, beneficiaryMemberId: input.beneficiaryMemberId ?? null }
    const inserted = await client.query<CommercialOrderV2>(`INSERT INTO commercial_orders_v2(id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,created_at) VALUES($1,$2,$3,$4,$5,'CNY',$6,'pending',$7,$8,$9,$10::timestamptz) RETURNING id,workspace_id AS "workspaceId",sku_id AS "skuId",sku_version_id AS "skuVersionId",amount_fen AS "amountFen",currency,payment_provider AS "paymentProvider",status,idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_by_actor_id AS "createdByActorId",provider_order_id AS "providerOrderId",checkout_url AS "checkoutUrl",checkout_expires_at AS "checkoutExpiresAt",checkout_idempotency_key AS "checkoutIdempotencyKey",created_at AS "createdAt",paid_at AS "paidAt"`, [orderId, workspaceId, sku.id, sku.versionId, amountFen, input.paymentProvider, input.idempotencyKey, requestHash, input.createdByActorId, at])
    const snapshot = { schema_version: 'commercial-order.v3', sku, purchase_terms: terms }
    await client.query(`INSERT INTO commercial_order_snapshots_v2(id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz)`, [snapshotId, workspaceId, orderId, sku.id, sku.versionId, sku.checksum, JSON.stringify(snapshot), hash(snapshot), at])
    await client.query(`INSERT INTO commercial_order_terms_v3(workspace_id,order_id,purchase_kind,expires_at,policy_version,checkout_id,onboarding_order_id,upgrade_quote_id,beneficiary_member_id,created_at) VALUES($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10::timestamptz)`, [workspaceId, orderId, kind, expiresAt, policy.version, terms.checkoutId, terms.onboardingOrderId, terms.upgradeQuoteId, terms.beneficiaryMemberId ?? null, at])
    await this.outbox(client, workspaceId, orderId, 'commercial.order_created', { order_id: orderId, purchase_kind: kind, actor_id: input.createdByActorId, reason: input.reason }, at)
    if (!inserted.rows[0]) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'order insertion returned no fact')
    return mapOrder({ ...inserted.rows[0], ...terms, grantStatus: 'pending' })
  }

  /** Receipt owner holds its balance lock before entering this method; no new
   * transaction is opened, so allocation, payment and entitlement commit once. */
  async recordVerifiedPaymentAndGrantInTransaction(client: SqlClient, input: VerifiedPaymentGrantInput): Promise<PaymentGrantResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId), paidAt = iso(input.paidAt), verifiedAt = iso(input.verifiedAt ?? new Date())
    await workspaceLock(client, workspaceId)
    const result = await client.query<OrderFact>(`SELECT ${projection},${termsProjection},s.id AS "snapshotId",s.snapshot FROM commercial_orders_v2 o JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o,t`, [workspaceId, input.orderId])
    const row = result.rows[0]
    if (!row) throw new CommercialContractError('COMMERCIAL_ORDER_NOT_FOUND', 'order not found')
    if (row.paymentProvider !== input.provider || integer(row.amountFen) !== input.amountFen || row.currency !== input.currency) throw new CommercialContractError('COMMERCIAL_PAYMENT_MISMATCH', 'payment differs from immutable order')
    const prior = await client.query<{ payloadHash: string; orderId: string }>(`SELECT payload_hash AS "payloadHash",order_id AS "orderId" FROM commercial_payment_events_v2 WHERE provider=$1 AND provider_event_id=$2`, [input.provider, input.providerEventId])
    if (prior.rows[0] && (prior.rows[0].orderId !== input.orderId || prior.rows[0].payloadHash !== input.payloadHash)) throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'payment fact key reused')
    if (prior.rows[0] && row.grantStatus !== 'awaiting_dependency') {
      const grants = await client.query<{ grantId: string }>(`SELECT id AS "grantId" FROM creative_point_grants WHERE workspace_id=$1 AND source_type='commercial_order_v2' AND source_id=$2 LIMIT 1`, [workspaceId, input.orderId])
      const state = await balance(client, workspaceId)
      return { order: mapOrder(row), grantId: grants.rows[0]?.grantId ?? null, grantStatus: row.grantStatus, accessRevision: state.revision, availablePoints: state.available, replayed: true }
    }
    if (!prior.rows[0]) {
      if (row.status !== 'pending' && row.status !== 'closed') throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'order already has a different payment intent')
      await client.query(`INSERT INTO commercial_payment_events_v2(id,workspace_id,order_id,provider,provider_event_id,nonce,payload_hash,event_type,verified,amount_fen,currency,payment_subject_ref,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,'paid',true,$8,$9,$10,$11::timestamptz)`, [id('cpe'), workspaceId, input.orderId, input.provider, input.providerEventId, input.nonce, input.payloadHash, input.amountFen, input.currency, input.paymentSubjectRef ?? null, paidAt])
    }
    const finish = async (grantStatus: CommercialGrantStatusV3, grantId: string | null): Promise<PaymentGrantResult> => {
      const orderStatus = grantStatus === 'reconciliation_required' ? 'reconciliation_required' : 'paid'
      await client.query(`UPDATE commercial_orders_v2 SET status=$3,provider_order_id=$4,paid_at=$5::timestamptz WHERE workspace_id=$1 AND id=$2`, [workspaceId, input.orderId, orderStatus, input.providerOrderId, paidAt])
      await client.query(`UPDATE commercial_order_terms_v3 SET grant_status=$3,granted_at=$4::timestamptz WHERE workspace_id=$1 AND order_id=$2`, [workspaceId, input.orderId, grantStatus, grantStatus === 'active' || grantStatus === 'scheduled' ? verifiedAt : null])
      const state = await balance(client, workspaceId)
      await this.outbox(client, workspaceId, input.orderId, `commercial.payment.${grantStatus}`, { order_id: input.orderId, grant_id: grantId, grant_status: grantStatus, access_revision: state.revision, paid_at: paidAt, verified_at: verifiedAt, payment_event_id: input.providerEventId }, verifiedAt)
      await client.query(`INSERT INTO commercial_access_decisions_v2(id,workspace_id,request_id,operation_key,access_class,balance_state,available_points,reserved_points,quoted_points,access_revision,allowed,code,next_actions,evidence,decided_at) VALUES($1,$2,$3,'payment.grant.commit','RECOVERY_CONTROL','known',$4,$5,NULL,$6,true,'OK','[]'::jsonb,$7::jsonb,$8::timestamptz) ON CONFLICT(workspace_id,request_id,operation_key) DO NOTHING`, [id('cad'), workspaceId, `${input.orderId}:${grantStatus}`, state.available, state.reserved, state.revision, JSON.stringify({ grant_status: grantStatus, payment_event_id: input.providerEventId }), verifiedAt])
      return { order: mapOrder({ ...row, status: orderStatus, paidAt, providerOrderId: input.providerOrderId, grantStatus }), grantId, grantStatus, accessRevision: state.revision, availablePoints: state.available, replayed: false }
    }
    if (row.snapshot.sku.kind === 'monthly') {
      try { assertSupportedCommercialCycleGrantPolicy({ cycle: row.snapshot.sku.payload.cycle, pointGrantPolicy: row.snapshot.sku.payload.pointGrantPolicy }) }
      catch { return finish('reconciliation_required', null) }
    }
    if (!commercialPaymentIsTimely({ paidAt, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt) }) || Date.parse(paidAt) > Date.parse(verifiedAt)) return finish('reconciliation_required', null)
    const sku = row.snapshot.sku
    const qualification = await this.onboardingStatusInTransaction(client, workspaceId)
    if (row.purchaseKind === 'onboarding_once') {
      if (qualification.qualified || qualification.status === 'blocked') return finish('reconciliation_required', null)
      const schedule = commercialOnboardingGrantSchedule(sku)
      const firstExpiry = monthlyAnniversary(verifiedAt, 1)
      const grantId = await this.grantPoints(client, workspaceId, input.orderId, schedule.pointsPerGrant, firstExpiry, verifiedAt, `payment:${input.provider}:${input.providerEventId}`)
      for (let index = 0; index < schedule.grantCount; index += 1) {
        await client.query(`INSERT INTO onboarding_point_grant_schedules_v2(id,workspace_id,onboarding_order_id,sequence,points,due_at,expires_at,policy_ref,status,grant_id,blockers,entitlement_snapshot_id,source_checksum,created_by_actor_id,creation_reason,creation_evidence) VALUES($1,$2,$3,$4,$13,$5::timestamptz,$6::timestamptz,'commercial.onboarding.v2',$7,$8,'[]'::jsonb,$9,$10,$11,'verified onboarding payment grant schedule',$12::jsonb) ON CONFLICT(workspace_id,onboarding_order_id,sequence) DO NOTHING`, [id('opgs'), workspaceId, input.orderId, index + 1, monthlyAnniversary(verifiedAt, index), monthlyAnniversary(verifiedAt, index + 1), index === 0 ? 'granted' : 'scheduled', index === 0 ? grantId : null, row.snapshotId, sku.checksum, row.createdByActorId, JSON.stringify({ payment_event_id: input.providerEventId, verified_at: verifiedAt }), schedule.pointsPerGrant])
      }
      await client.query(`INSERT INTO workspace_commercial_onboarding_v3(workspace_id,onboarding_order_id,status,activated_at,revision) VALUES($1,$2,'active',$3::timestamptz,1) ON CONFLICT(workspace_id) DO UPDATE SET onboarding_order_id=excluded.onboarding_order_id,status='active',activated_at=excluded.activated_at,revision=workspace_commercial_onboarding_v3.revision+1 WHERE workspace_commercial_onboarding_v3.status='revoked'`, [workspaceId, input.orderId, verifiedAt])
      const completed = await finish('active', grantId)
      await this.recoverAwaitingDependenciesInTransaction(client, workspaceId, input.orderId, verifiedAt)
      return completed
    }
    if (!qualification.qualified) {
      if (!row.onboardingOrderId || !row.checkoutId) return finish('reconciliation_required', null)
      return finish('awaiting_dependency', null)
    }
    let points = 0, grantExpiry: string, periodId: string | null = null, periodStart: string | null = null, periodEnd: string | null = null
    if (row.purchaseKind === 'upgrade') {
      const quoteResult = await client.query<{ quote: CommercialUpgradeQuoteV3; target: CommercialCatalogSkuSnapshot }>(`SELECT quote,target_snapshot AS target FROM commercial_upgrade_quotes_v3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, row.upgradeQuoteId])
      const frozen = quoteResult.rows[0], current = await currentPeriod(client, workspaceId, verifiedAt)
      if (!frozen || !current || current.periodId !== frozen.quote.sourcePeriodId || current.revision !== frozen.quote.sourcePeriodRevision || current.entitlementId !== frozen.quote.sourceEntitlementId || Date.parse(frozen.quote.periodEnd) <= Date.parse(verifiedAt) || frozen.quote.amountFen !== input.amountFen) return finish('reconciliation_required', null)
      const quote = frozen.quote
      periodId = current.periodId; periodStart = current.periodStart; periodEnd = current.periodEnd; grantExpiry = periodEnd
      const nextRevision = current.revision + 1
      const resolvedBenefits = frozen.target.benefits.map(benefit => {
        const increment = quote.benefitIncrements.find(value => value.code === benefit.code)
        if (increment?.kind !== 'consumable' || ['monthly_creative_points','creative_points'].includes(benefit.code)) return benefit
        const priorBenefit = current.resolvedBenefits.find(value => value.code === benefit.code)
        const quantity = integer(priorBenefit?.normalizedValue ?? priorBenefit?.quantity ?? 0) + increment.quantity
        return { ...benefit, quantity, normalizedValue: benefit.normalizedValue === null ? null : quantity }
      })
      await client.query(`UPDATE workspace_subscription_periods_v2 SET revision=$3 WHERE workspace_id=$1 AND id=$2 AND revision=$4`, [workspaceId, periodId, nextRevision, current.revision])
      await client.query(`INSERT INTO workspace_entitlement_snapshots_v2(id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,resolved_benefits,unresolved_blockers,executable,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,'[]'::jsonb,true,$7,$8::timestamptz)`, [id('ces'), workspaceId, periodId, nextRevision, frozen.target.versionId, JSON.stringify(resolvedBenefits), hash({ benefits: resolvedBenefits, quote_id: quote.id }), verifiedAt])
      await client.query(`INSERT INTO commercial_upgrade_events_v3(workspace_id,id,order_id,quote_id,period_id,from_revision,to_revision,target_snapshot,quote,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::timestamptz)`, [workspaceId, id('cue'), input.orderId, quote.id, periodId, current.revision, nextRevision, JSON.stringify(frozen.target), JSON.stringify(quote), verifiedAt])
      points = quote.benefitIncrements.filter(value => ['monthly_creative_points','creative_points'].includes(value.code)).reduce((sum, value) => sum + value.quantity, 0)
      // The authoritative snapshot revision must invalidate cached admission even
      // if the prorated point increment rounds down to zero.
      await client.query(`INSERT INTO creative_point_access_state(workspace_id,available_points,reserved_points,settled_points,revision,updated_at) VALUES($1,0,0,0,0,$2::timestamptz) ON CONFLICT(workspace_id) DO NOTHING`, [workspaceId, verifiedAt])
      await client.query(`UPDATE creative_point_access_state SET revision=revision+1,updated_at=$2::timestamptz WHERE workspace_id=$1`, [workspaceId, verifiedAt])
    } else if (sku.kind === 'monthly') {
      const current = await currentPeriod(client, workspaceId, verifiedAt)
      const future = await client.query<{ periodEnd: string }>(`SELECT period_end AS "periodEnd" FROM workspace_subscription_periods_v2 WHERE workspace_id=$1 AND status='active' AND period_end>$2::timestamptz ORDER BY period_end DESC,id DESC FOR UPDATE`, [workspaceId, verifiedAt])
      if (row.purchaseKind === 'purchase' && (current || future.rows[0])) return finish('reconciliation_required', null)
      periodStart = iso(new Date(Math.max(Date.parse(verifiedAt), ...future.rows.map(value => Date.parse(iso(value.periodEnd))))))
      periodEnd = cycleEnd(sku, periodStart); periodId = id('csp'); grantExpiry = periodEnd
      await client.query(`INSERT INTO workspace_subscription_periods_v2(id,workspace_id,order_snapshot_id,period_start,period_end,status,revision,created_at) VALUES($1,$2,$3,$4::timestamptz,$5::timestamptz,'active',1,$6::timestamptz)`, [periodId, workspaceId, row.snapshotId, periodStart, periodEnd, verifiedAt])
      await client.query(`INSERT INTO workspace_entitlement_snapshots_v2(id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,resolved_benefits,unresolved_blockers,executable,checksum,created_at) VALUES($1,$2,$3,1,$4,$5::jsonb,'[]'::jsonb,true,$6,$7::timestamptz)`, [id('ces'), workspaceId, periodId, sku.versionId, JSON.stringify(sku.benefits), hash(sku.benefits), verifiedAt])
      const pointBenefits = sku.benefits.filter(value => value.code === 'monthly_creative_points')
      if (pointBenefits.length !== 1) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'unique monthly point benefit required')
      points = integer(pointBenefits[0]?.quantity)
    } else if (sku.kind === 'point_pack') {
      const expiryDays = integer(sku.payload.expiryDays)
      if (expiryDays < 1 || !['purchase_plus_30_natural_days','purchase_plus_natural_days'].includes(String(sku.payload.expiryRule))) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'point-pack expiry unresolved')
      grantExpiry = new Date(Date.parse(verifiedAt) + expiryDays * 86400000).toISOString()
      const pointBenefits = sku.benefits.filter(value => value.code === 'creative_points')
      if (pointBenefits.length !== 1) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'unique pack point benefit required')
      points = integer(pointBenefits[0]?.quantity)
    } else throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'unsupported granted sale kind')
    if (points <= 0 && row.purchaseKind !== 'upgrade') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'positive point grant required')
    // A multi-month monthly cadence has one source-isolated plan per batch.
    const cycle = sku.kind === 'monthly' && row.purchaseKind !== 'upgrade' ? commercialCycle(sku) : null
    const monthlyCadence = cycle?.unit === 'month' && cycle.count > 1 && (sku.payload.pointGrantPolicy as Record<string, unknown> | undefined)?.cadence === 'monthly'
    if (cycle && cycle.count > 1 && !monthlyCadence && (sku.payload.pointGrantPolicy as Record<string, unknown> | undefined)?.cadence !== 'once') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'approved multi-period point cadence required')
    const batchCount = monthlyCadence ? cycle!.count : 1
    let grantId: string | null = null
    for (let sequence = 1; sequence <= batchCount && points > 0; sequence += 1) {
      const dueAt = periodStart ? monthlyCadence ? monthlyAnniversary(periodStart, sequence - 1) : periodStart : verifiedAt
      const expiry = monthlyCadence ? monthlyAnniversary(periodStart!, sequence) : grantExpiry
      if (Date.parse(dueAt) > Date.parse(verifiedAt)) {
        await client.query(`INSERT INTO commercial_point_grant_schedules_v3(workspace_id,id,order_id,period_id,sequence,points,due_at,expires_at,status,evidence,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,'scheduled',$9::jsonb,$10::timestamptz)`, [workspaceId, id('cpgs'), input.orderId, periodId, sequence, points, dueAt, expiry, JSON.stringify({ sku_version_id: sku.versionId, payment_event_id: input.providerEventId }), verifiedAt])
      } else {
        grantId = await this.grantPoints(client, workspaceId, input.orderId, points, expiry, verifiedAt, `payment:${input.provider}:${input.providerEventId}:batch:${sequence}`)
      }
    }
    return finish(periodStart && Date.parse(periodStart) > Date.parse(verifiedAt) ? 'scheduled' : 'active', grantId)
  }

  private async grantPoints(client: SqlClient, workspaceId: string, orderId: string, points: number, expiresAt: string, at: string, key: string, scheduleSourceId?: string): Promise<string> {
    if (!Number.isSafeInteger(points) || points < 1 || Date.parse(expiresAt) <= Date.parse(at)) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'grant must be positive and unexpired')
    await client.query(`INSERT INTO creative_point_access_state(workspace_id,available_points,reserved_points,settled_points,revision,updated_at) VALUES($1,0,0,0,0,$2::timestamptz) ON CONFLICT(workspace_id) DO NOTHING`, [workspaceId, at])
    await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
    const operationId = id('cpo'), grantId = id('cpg')
    const sourceType = scheduleSourceId ? 'commercial_schedule_v3' : 'commercial_order_v2', sourceId = scheduleSourceId ?? orderId
    await client.query(`INSERT INTO creative_point_operations(id,workspace_id,kind,idempotency_key,status,request,created_at) VALUES($1,$2,'grant',$3,'pending',$4::jsonb,$5::timestamptz)`, [operationId, workspaceId, key, JSON.stringify({ source_type: sourceType, source_id: sourceId, order_id: orderId, points, expires_at: expiresAt }), at])
    await client.query(`INSERT INTO creative_point_grants(id,workspace_id,operation_id,source_type,source_id,points,expires_at,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::jsonb,$9::timestamptz)`, [grantId, workspaceId, operationId, sourceType, sourceId, points, expiresAt, JSON.stringify({ schedule_key: key, order_id: orderId }), at])
    const result = await client.query<{ available: number; reserved: number; settled: number; revision: number }>(`UPDATE creative_point_access_state SET available_points=COALESCE(available_points,0)+$2,reserved_points=COALESCE(reserved_points,0),settled_points=COALESCE(settled_points,0),revision=revision+1,updated_at=$3::timestamptz WHERE workspace_id=$1 RETURNING available_points AS available,reserved_points AS reserved,settled_points AS settled,revision`, [workspaceId, points, at])
    const state = result.rows[0]
    if (!state) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'balance state unavailable')
    await client.query(`INSERT INTO creative_point_ledger_events(id,workspace_id,operation_id,event_type,points_delta,available_after,reserved_after,settled_after,access_revision,metadata,created_at) VALUES($1,$2,$3,'granted',$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`, [id('cpl'), workspaceId, operationId, points, state.available, state.reserved, state.settled, state.revision, JSON.stringify({ order_id: orderId }), at])
    await client.query(`UPDATE creative_point_operations SET status='completed',result=jsonb_build_object('entity_id',$3::text),completed_at=$4::timestamptz WHERE workspace_id=$1 AND id=$2`, [workspaceId, operationId, grantId, at])
    return grantId
  }

  /** Called after receipt/workspace/order locks and before source point locks.
   * An approved external payout freezes this source until a matching completion.
   * Unsupported service consumption remains an explicit human policy decision. */
  async preflightSourceRecoveryInTransaction(client: SqlClient, input: { workspaceId: string; orderId: string; requestId: string; amountFen: number; pointsToRevoke: number; policyVersion: string; phase: 'approve' | 'complete' | 'reject'; now: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId), at = iso(input.now)
    await workspaceLock(client, workspaceId)
    const result = await client.query<OrderFact>(`SELECT ${projection},${termsProjection},s.id AS "snapshotId",s.snapshot FROM commercial_orders_v2 o JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o,t`, [workspaceId, input.orderId])
    const row = result.rows[0]
    if (!row) return { legacy: true }
    const hold = (await client.query<{ state: string; priorPeriodStatus: string | null }>(`SELECT state,prior_period_status AS "priorPeriodStatus" FROM commercial_source_recovery_holds_v3 WHERE workspace_id=$1 AND request_id=$2 FOR UPDATE`, [workspaceId, input.requestId])).rows[0]
    if (input.phase === 'reject') {
      // Current API only rejects requested refunds, which have never acquired a
      // financial commitment. Approved external payouts need a separate factual
      // cancellation protocol and cannot enter this path.
      if (hold?.state === 'frozen') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'approved source refund cannot be released without external cancellation evidence')
      return { released: false }
    }
    if (hold?.state === 'completed') return { replayed: true }
    const policy = row.snapshot.sku.payload.sourceRecoveryPolicy as Record<string, unknown> | undefined
    const cashOnly = ['awaiting_dependency','reconciliation_required'].includes(row.grantStatus ?? 'pending')
    if (!cashOnly && (policy?.approved !== true || policy.version !== input.policyVersion || !['unused_points_only','cancel_contract'].includes(String(policy.effect)))) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'frozen approved source recovery policy required')
    if (!cashOnly && policy!.effect === 'unused_points_only' && row.purchaseKind !== 'point_pack') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'contract refund must specify contract cancellation')
    if (!cashOnly && policy!.effect === 'cancel_contract' && input.amountFen !== integer(row.amountFen)) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'partial contract refund requires a separately approved consumed-service valuation')
    if (!cashOnly && policy!.effect === 'cancel_contract' && input.phase === 'approve') {
      const source = await client.query<{ total: string; allocated: string }>(`SELECT COALESCE(sum(g.points),0) AS total,COALESCE(sum(a.allocated),0) AS allocated FROM creative_point_grants g LEFT JOIN LATERAL(SELECT COALESCE(sum(points_delta),0) AS allocated FROM creative_point_allocations WHERE workspace_id=g.workspace_id AND grant_id=g.id) a ON true WHERE g.workspace_id=$1 AND ((g.source_type='commercial_order_v2' AND g.source_id=$2) OR (g.source_type='commercial_schedule_v3' AND EXISTS(SELECT 1 FROM commercial_point_grant_schedules_v3 s WHERE s.workspace_id=g.workspace_id AND s.id=g.source_id AND s.order_id=$2)) OR (g.source_type='onboarding_schedule_v2' AND EXISTS(SELECT 1 FROM onboarding_point_grant_schedules_v2 s WHERE s.workspace_id=g.workspace_id AND s.id=g.source_id AND s.onboarding_order_id=$2)))`,[workspaceId,input.orderId])
      if (integer(source.rows[0]?.allocated ?? 0) !== 0 || integer(source.rows[0]?.total ?? 0) !== input.pointsToRevoke) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','full source cancellation requires all granted points unused and included in recovery')
    }
    const periods = await client.query<{ id: string; status: string; revision: number; periodStart: string }>(`SELECT id,status,revision,period_start AS "periodStart" FROM workspace_subscription_periods_v2 WHERE workspace_id=$1 AND order_snapshot_id=$2 ORDER BY id FOR UPDATE`, [workspaceId, row.snapshotId])
    let upgrade: { quote: CommercialUpgradeQuoteV3; periodId: string; revision: number } | undefined
    if (!cashOnly && row.purchaseKind === 'upgrade') {
      const event = (await client.query<{ quote: CommercialUpgradeQuoteV3; periodId: string; revision: number }>(`SELECT u.quote,u.period_id AS "periodId",p.revision FROM commercial_upgrade_events_v3 u JOIN workspace_subscription_periods_v2 p ON p.workspace_id=u.workspace_id AND p.id=u.period_id WHERE u.workspace_id=$1 AND u.order_id=$2 AND u.to_revision=p.revision FOR UPDATE OF p`, [workspaceId,input.orderId])).rows[0]
      if (!event) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'only latest source upgrade revision can be restored automatically')
      upgrade = event
    }
    const periodIds = [...periods.rows.map(p => p.id), ...(upgrade ? [upgrade.periodId] : [])]
    if (periodIds.length) {
      if (!upgrade) {
        const upgrades = await client.query<{id:string}>(`SELECT u.id FROM commercial_upgrade_events_v3 u JOIN commercial_orders_v2 o ON o.workspace_id=u.workspace_id AND o.id=u.order_id WHERE u.workspace_id=$1 AND u.period_id=ANY($2::text[]) AND o.status='paid' LIMIT 1`,[workspaceId,periodIds])
        if (upgrades.rows[0]) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','paid source upgrades must be resolved before base contract refund')
      }
      const used = await client.query<{ id: string }>(`SELECT a.id FROM workspace_service_allocations a JOIN workspace_entitlement_snapshots_v2 e ON e.workspace_id=a.workspace_id AND e.id=a.entitlement_snapshot_id WHERE a.workspace_id=$1 AND e.subscription_period_id=ANY($2::text[]) AND (a.used_quantity>0 OR a.status IN ('scheduled','in_progress','completed')) LIMIT 1`, [workspaceId,periodIds])
      if (used.rows[0]) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'used or committed service needs approved source valuation before refund')
    }
    // Absolute resources belong to the workspace, not to whichever point
    // source funded a workflow. Never erase usage or infer source ownership.
    const removesCurrentPeriod = periods.rows.some(period => Date.parse(iso(period.periodStart)) <= Date.parse(at))
    if (!cashOnly && (upgrade || removesCurrentPeriod)) {
      let restoredBenefits: CommercialCatalogSkuSnapshot['benefits'] = []
      if (upgrade) {
        const source = (await client.query<{benefits:CommercialCatalogSkuSnapshot['benefits']}>(`SELECT resolved_benefits AS benefits FROM workspace_entitlement_snapshots_v2 WHERE workspace_id=$1 AND id=$2 AND subscription_period_id=$3`,[workspaceId,upgrade.quote.sourceEntitlementId,upgrade.periodId])).rows[0]
        if (!source || !Array.isArray(source.benefits)) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','source resource limits are unavailable')
        restoredBenefits = source.benefits
      }
      await this.assertSourceResourceRecoveryInTransaction(client,workspaceId,row.snapshot.sku.benefits,restoredBenefits)
    }
    if (!cashOnly && row.purchaseKind === 'onboarding_once') {
      const dependencies = await client.query<{ id: string }>(`SELECT o.id FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id WHERE o.workspace_id=$1 AND o.id<>$2 AND o.status='paid' AND s.snapshot->'sku'->>'kind' IN ('monthly','point_pack') LIMIT 1`, [workspaceId,input.orderId])
      if (dependencies.rows[0]) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'paid dependent contracts must be resolved before qualification refund')
    }
    if (input.phase === 'approve') {
      await client.query(`INSERT INTO commercial_source_recovery_holds_v3(workspace_id,order_id,request_id,policy_version,state,prior_period_status,created_at,updated_at) VALUES($1,$2,$3,$4,'frozen',$5,$6::timestamptz,$6::timestamptz) ON CONFLICT(workspace_id,request_id) DO NOTHING`, [workspaceId,input.orderId,input.requestId,input.policyVersion,periods.rows[0]?.status ?? (upgrade ? 'active' : null),at])
      if (row.purchaseKind === 'onboarding_once') await client.query(`UPDATE workspace_commercial_onboarding_v3 SET status='blocked',revision=revision+1 WHERE workspace_id=$1 AND onboarding_order_id=$2`,[workspaceId,input.orderId])
      if (periodIds.length) await client.query(`UPDATE workspace_subscription_periods_v2 SET status='blocked' WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,periodIds])
      await this.outbox(client,workspaceId,input.requestId,'commercial.source_recovery.frozen',{order_id:input.orderId,request_id:input.requestId},at)
      return { frozen: true }
    }
    if (!hold || hold.state !== 'frozen') throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'source refund completion requires matching frozen approval')
    if (upgrade) {
      const old = (await client.query<{ benefits: CommercialCatalogSkuSnapshot['benefits']; catalogVersionId: string; checksum: string }>(`SELECT resolved_benefits AS benefits,catalog_version_id AS "catalogVersionId",checksum FROM workspace_entitlement_snapshots_v2 WHERE workspace_id=$1 AND id=$2 AND subscription_period_id=$3`,[workspaceId,upgrade.quote.sourceEntitlementId,upgrade.periodId])).rows[0]
      if (!old || !upgrade.quote.sourceSnapshot) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'frozen source revision unavailable for restore')
      const revision = integer(upgrade.revision)+1
      await client.query(`UPDATE workspace_subscription_periods_v2 SET status='active',revision=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,upgrade.periodId,revision])
      await client.query(`INSERT INTO workspace_entitlement_snapshots_v2(id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,resolved_benefits,unresolved_blockers,executable,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,'[]'::jsonb,true,$7,$8::timestamptz)`,[id('ces'),workspaceId,upgrade.periodId,revision,old.catalogVersionId,JSON.stringify(old.benefits),hash({source:old.checksum,refund:input.requestId}),at])
      await client.query(`UPDATE commercial_source_recovery_holds_v3 SET restored_period_id=$3,restored_revision=$4,restored_snapshot=$5::jsonb,restored_quote=$6::jsonb WHERE workspace_id=$1 AND request_id=$2`,[workspaceId,input.requestId,upgrade.periodId,revision,JSON.stringify(upgrade.quote.sourceSnapshot),upgrade.quote.sourceUpgradeQuote ? JSON.stringify(upgrade.quote.sourceUpgradeQuote) : null])
    } else if (periodIds.length) await client.query(`UPDATE workspace_subscription_periods_v2 SET status='canceled',revision=revision+1 WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,periodIds])
    await client.query(`UPDATE commercial_point_grant_schedules_v3 SET status='canceled' WHERE workspace_id=$1 AND order_id=$2 AND status='scheduled'`,[workspaceId,input.orderId])
    await client.query(`UPDATE onboarding_point_grant_schedules_v2 SET status='canceled' WHERE workspace_id=$1 AND onboarding_order_id=$2 AND status='scheduled'`,[workspaceId,input.orderId])
    if (row.purchaseKind === 'onboarding_once') await client.query(`UPDATE workspace_commercial_onboarding_v3 SET status='revoked',revision=revision+1 WHERE workspace_id=$1 AND onboarding_order_id=$2`,[workspaceId,input.orderId])
    await client.query(`UPDATE commercial_order_terms_v3 SET grant_status='refunded' WHERE workspace_id=$1 AND order_id=$2`,[workspaceId,input.orderId])
    await client.query(`UPDATE commercial_source_recovery_holds_v3 SET state='completed',updated_at=$3::timestamptz WHERE workspace_id=$1 AND request_id=$2`,[workspaceId,input.requestId,at])
    await client.query(`UPDATE creative_point_access_state SET revision=revision+1,updated_at=$2::timestamptz WHERE workspace_id=$1`,[workspaceId,at])
    await this.outbox(client,workspaceId,input.requestId,'commercial.source_recovery.completed',{order_id:input.orderId,request_id:input.requestId},at)
    return { completed: true }
  }

  private async assertSourceResourceRecoveryInTransaction(client:SqlClient,workspaceId:string,currentBenefits:CommercialCatalogSkuSnapshot['benefits'],restoredBenefits:CommercialCatalogSkuSnapshot['benefits']) {
    const limit = (code:string):number => {
      const matches=restoredBenefits.filter(benefit=>benefit.code===code)
      if (!matches.length) return 0
      if (matches.length!==1) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','ambiguous restored resource limit')
      const value=code==='cloud_storage'?matches[0]!.normalizedValue:matches[0]!.quantity
      if (value===null || value===undefined) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','restored resource limit is unresolved')
      return integer(value)
    }
    const usage=(await client.query<{brands:string;stores:string}>(`SELECT (SELECT count(*) FROM brands WHERE workspace_id=$1) AS brands,GREATEST((SELECT count(*) FROM platform_accounts WHERE workspace_id=$1 AND token_state<>'revoked'),(SELECT count(DISTINCT(platform,platform_account_id)) FROM brand_store_bindings WHERE workspace_id=$1 AND status='active')) AS stores`,[workspaceId])).rows[0]
    if (!usage || integer(usage.brands)>limit('max_brands') || integer(usage.stores)>limit('max_stores')) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','actual brands or connected stores exceed restored limits; usage requires controlled source valuation')
    const storage=(await client.query<{used:string;reserved:string}>(`SELECT used_bytes AS used,reserved_bytes AS reserved FROM workspace_storage_quotas WHERE workspace_id=$1 FOR UPDATE`,[workspaceId])).rows[0]
    if (storage && BigInt(storage.used)+BigInt(storage.reserved)>BigInt(limit('cloud_storage'))) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','actual stored and reserved bytes exceed restored capacity; resolve usage before source refund')
    // There is no durable source-bound proof that a previously enabled feature
    // has never been exercised using gifts or independent point packs. A point
    // ledger balance cannot justify automatic monetary recovery of that feature.
    for (const definition of COMMERCIAL_BENEFIT_DEFINITIONS.filter(item=>item.upgradeSemantics==='boolean')) {
      const enabled=currentBenefits.find(benefit=>benefit.code===definition.code)
      const restored=restoredBenefits.find(benefit=>benefit.code===definition.code)
      if (enabled && integer(enabled.quantity)>0 && (!restored || integer(restored.quantity)===0)) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED','enabled feature removal requires approved controlled recovery; unused feature consumption cannot be proven from point source')
    }
  }

  async dispatchDueScheduledGrants(input: { workspaceId: string; now?: string; limit?: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId), at = iso(input.now ?? new Date()), limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be between 1 and 100')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await workspaceLock(client, workspaceId)
      const result = await client.query<{ id: string; sequence: number; orderId: string; points: number; dueAt: string; expiresAt: string; orderStatus: string; periodStatus: string | null }>(`SELECT s.id,s.sequence,s.order_id AS "orderId",s.points,s.due_at AS "dueAt",s.expires_at AS "expiresAt",o.status AS "orderStatus",p.status AS "periodStatus" FROM commercial_point_grant_schedules_v3 s JOIN commercial_orders_v2 o ON o.workspace_id=s.workspace_id AND o.id=s.order_id LEFT JOIN workspace_subscription_periods_v2 p ON p.workspace_id=s.workspace_id AND p.id=s.period_id WHERE s.workspace_id=$1 AND s.status='scheduled' AND s.due_at<=$2::timestamptz AND NOT EXISTS(SELECT 1 FROM commercial_source_recovery_holds_v3 h WHERE h.workspace_id=s.workspace_id AND h.order_id=s.order_id AND h.state='frozen') ORDER BY s.due_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT $3`, [workspaceId, at, limit])
      let dispatched = 0, expired = 0, canceled = 0
      const grantIds: string[] = []
      for (const row of result.rows) {
        if (row.orderStatus !== 'paid' || row.periodStatus === 'canceled' || row.periodStatus === 'blocked') {
          await client.query(`UPDATE commercial_point_grant_schedules_v3 SET status='canceled' WHERE workspace_id=$1 AND id=$2 AND status='scheduled'`, [workspaceId, row.id]); canceled += 1; continue
        }
        if (Date.parse(iso(row.expiresAt)) <= Date.parse(at)) {
          await client.query(`UPDATE commercial_point_grant_schedules_v3 SET status='expired' WHERE workspace_id=$1 AND id=$2 AND status='scheduled'`, [workspaceId, row.id])
          await this.outbox(client, workspaceId, row.id, 'commercial.point_schedule.expired', { order_id: row.orderId, schedule_id: row.id, reason: 'grant window elapsed' }, at); expired += 1; continue
        }
        const grantId = await this.grantPoints(client, workspaceId, row.orderId, integer(row.points), iso(row.expiresAt), at, `commercial-schedule:${row.id}`, integer(row.sequence) > 1 ? row.id : undefined)
        await client.query(`UPDATE commercial_point_grant_schedules_v3 SET status='granted',grant_id=$3 WHERE workspace_id=$1 AND id=$2 AND status='scheduled'`, [workspaceId, row.id, grantId])
        await client.query(`UPDATE commercial_order_terms_v3 SET grant_status='active' WHERE workspace_id=$1 AND order_id=$2 AND grant_status='scheduled'`, [workspaceId, row.orderId])
        await this.outbox(client, workspaceId, row.id, 'commercial.point_schedule.granted', { order_id: row.orderId, schedule_id: row.id, grant_id: grantId }, at)
        dispatched += 1; grantIds.push(grantId)
      }
      return { workspaceId, dispatched, expired, canceled, grantIds }
    })
  }

  async getOrderSnapshot(workspaceId: string, orderId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, client => this.getOrderSnapshotInTransaction(client, scope, orderId))
  }

  async getOrderSnapshotInTransaction(client: SqlClient, workspaceId: string, orderId: string) {
      const scope = requireWorkspaceScope(workspaceId)
      const result = await client.query<OrderFact>(`SELECT ${projection},${termsProjection},s.id AS "snapshotId",s.snapshot FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id LEFT JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2`, [scope, orderId])
      return result.rows[0] ? { order: mapOrder(result.rows[0]), snapshot: result.rows[0].snapshot } : null
  }

  async getUpgradeQuote(workspaceId: string, quoteId: string): Promise<CommercialUpgradeQuoteV3 | null> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{ quote: CommercialUpgradeQuoteV3; targetSnapshot: CommercialCatalogSkuSnapshot }>(`SELECT quote,target_snapshot AS "targetSnapshot" FROM commercial_upgrade_quotes_v3 WHERE workspace_id=$1 AND id=$2`, [scope, quoteId])
      return result.rows[0] ? {...result.rows[0].quote,targetSnapshot:result.rows[0].targetSnapshot} : null
    })
  }

  async recoverAwaitingDependenciesInTransaction(client: SqlClient, workspaceId: string, onboardingOrderId: string, verifiedAt: string): Promise<PaymentGrantResult[]> {
    const result = await client.query<{ orderId: string; provider: string; providerOrderId: string; providerEventId: string; nonce: string; payloadHash: string; amountFen: number; currency: 'CNY'; paidAt: string; paymentSubjectRef: string | null }>(`SELECT o.id AS "orderId",o.payment_provider AS provider,o.provider_order_id AS "providerOrderId",e.provider_event_id AS "providerEventId",e.nonce,e.payload_hash AS "payloadHash",e.amount_fen AS "amountFen",e.currency,e.received_at AS "paidAt",e.payment_subject_ref AS "paymentSubjectRef" FROM commercial_order_terms_v3 t JOIN commercial_orders_v2 o ON o.workspace_id=t.workspace_id AND o.id=t.order_id JOIN commercial_payment_events_v2 e ON e.workspace_id=o.workspace_id AND e.order_id=o.id WHERE t.workspace_id=$1 AND t.onboarding_order_id=$2 AND t.grant_status='awaiting_dependency' AND o.status='paid' AND e.verified ORDER BY o.id`, [workspaceId, onboardingOrderId])
    const results: PaymentGrantResult[] = []
    for (const row of result.rows) results.push(await this.recordVerifiedPaymentAndGrantInTransaction(client, { workspaceId, ...row, amountFen: integer(row.amountFen), paidAt: iso(row.paidAt), paymentSubjectRef: row.paymentSubjectRef ?? undefined, verifiedAt }))
    return results
  }

  async findOrderByIdempotencyKey(workspaceId: string, actorId: string, key: string, options: {onlyV3?: boolean} = {}) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const hasTerms = await hasCommercialRelationForVerifiedPrefix(client, 'commercial_order_terms_v3', 259)
      if (!hasTerms && options.onlyV3) return null
      type LookupFact = OrderFact & {snapshot:{schema_version?:string;sku:CommercialCatalogSkuSnapshot};snapshotChecksum:string;snapshotCatalogChecksum:string;termsOrderId?:string|null}
      const result = await client.query<LookupFact>(`SELECT ${projection},${hasTerms ? `${termsProjection},t.order_id AS "termsOrderId",` : ''}s.id AS "snapshotId",s.snapshot,s.checksum AS "snapshotChecksum",s.catalog_checksum AS "snapshotCatalogChecksum" FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id ${hasTerms ? 'LEFT JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id' : ''} WHERE o.workspace_id=$1 AND o.created_by_actor_id=$2 AND o.idempotency_key=$3`, [scope, actorId, key])
      const row = result.rows[0]
      if (!row) return null
      const order = mapOrder(row)
      if (!hasTerms) assertVerifiedLegacyOrderSnapshot(row, order)
      if (row.snapshot.schema_version === 'commercial-order.v3' && !row.termsOrderId) throw new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'V3 replay requires its original immutable terms')
      if (options.onlyV3 && row.snapshot.schema_version !== 'commercial-order.v3') return null
      return { order, snapshot: row.snapshot }
    })
  }

  async findQuoteByIdempotencyKey(workspaceId: string, actorId: string, key: string): Promise<CommercialUpgradeQuoteV3 | null> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      if (!await hasCommercialRelationForVerifiedPrefix(client, 'commercial_upgrade_quotes_v3', 259)) return null
      const result = await client.query<{ quote: CommercialUpgradeQuoteV3 }>(`SELECT quote FROM commercial_upgrade_quotes_v3 WHERE workspace_id=$1 AND idempotency_key=$2 AND quote->>'actorId'=$3`, [scope, key, actorId])
      return result.rows[0]?.quote ?? null
    })
  }

  async getSubscriptionSummary(input: { workspaceId: string; now?: string; limit?: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId), at = iso(input.now ?? new Date()), limit = input.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be between 1 and 100')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      if (!await hasCommercialRelationForVerifiedPrefix(client, 'workspace_commercial_onboarding_v3', 259)) throw new CommercialSchemaCompatibilityError('V3 subscription portfolio is unavailable on the verified historical schema')
      const qualification = await this.onboardingStatusInTransaction(client, workspaceId)
      // Current authority is selected before bounded historical pagination;
      // many new orders must never evict an older, still-active contract.
      const result = await client.query<CommercialEntitlementSnapshotV2 & {resolvedSku:CommercialCatalogSkuSnapshot|null}>(`SELECT e.id,e.workspace_id AS "workspaceId",p.id AS "subscriptionPeriodId",o.id AS "sourceOrderId",o.status AS "sourceOrderStatus",p.period_start AS "periodStart",p.period_end AS "periodEnd",p.status AS "periodStatus",e.catalog_version_id AS "catalogVersionId",COALESCE(u.target_snapshot,h.restored_snapshot,s.snapshot->'sku')->>'code' AS "skuCode",COALESCE(u.target_snapshot,h.restored_snapshot,s.snapshot->'sku') AS "resolvedSku",e.resolved_benefits AS "resolvedBenefits",e.unresolved_blockers AS "unresolvedBlockers",e.executable,e.checksum,e.created_at AS "createdAt" FROM workspace_entitlement_snapshots_v2 e JOIN workspace_subscription_periods_v2 p ON p.workspace_id=e.workspace_id AND p.id=e.subscription_period_id AND p.revision=e.subscription_period_revision JOIN commercial_order_snapshots_v2 s ON s.workspace_id=p.workspace_id AND s.id=p.order_snapshot_id JOIN commercial_orders_v2 o ON o.workspace_id=s.workspace_id AND o.id=s.order_id LEFT JOIN commercial_upgrade_events_v3 u ON u.workspace_id=p.workspace_id AND u.period_id=p.id AND u.to_revision=p.revision LEFT JOIN commercial_source_recovery_holds_v3 h ON h.workspace_id=p.workspace_id AND h.restored_period_id=p.id AND h.restored_revision=p.revision AND h.state='completed' WHERE p.workspace_id=$1 ORDER BY CASE WHEN p.status='active' AND p.period_start<=$2::timestamptz AND p.period_end>$2::timestamptz THEN 0 WHEN p.status='active' AND p.period_start>$2::timestamptz THEN 1 ELSE 2 END,CASE WHEN p.period_start>$2::timestamptz THEN p.period_start END ASC,e.created_at DESC,e.id DESC LIMIT $3`, [workspaceId,at,limit])
      const snapshots = result.rows.map(({resolvedSku,...row}) => ({ ...row,
        plan_family: typeof resolvedSku?.payload.planFamily === 'string' && resolvedSku.payload.planFamily.trim() ? resolvedSku.payload.planFamily : null,
        tier_rank: Number.isSafeInteger(resolvedSku?.payload.tierRank) && Number(resolvedSku?.payload.tierRank) > 0 ? Number(resolvedSku!.payload.tierRank) : null,
        periodStart: iso(row.periodStart as string), periodEnd: iso(row.periodEnd as string), createdAt: iso(row.createdAt as string) }))
      const current = snapshots.filter(row => row.periodStatus === 'active' && row.sourceOrderStatus === 'paid' && row.executable && Date.parse(row.periodStart) <= Date.parse(at) && Date.parse(row.periodEnd) > Date.parse(at))
      if (current.length > 1) throw new CommercialContractError('COMMERCIAL_ENTITLEMENT_CONFLICT', 'multiple authoritative periods')
      const orderResult = await client.query<OrderFact>(`SELECT ${projection},${termsProjection},s.id AS "snapshotId",s.snapshot FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id LEFT JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id WHERE o.workspace_id=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT $2`, [workspaceId, limit])
      // The order page is bounded history. Build the current point-pack portfolio
      // from source grants instead, so newer orders cannot evict an unexpired,
      // unspent pack from the merchant's effective benefits view.
      const hasRefundSourceHolds = await hasCommercialRelationForVerifiedPrefix(client, 'commercial_refund_source_holds_v2', 261)
      const heldPoints = hasRefundSourceHolds
        ? `COALESCE((SELECT sum(h.points) FROM commercial_refund_source_holds_v2 h WHERE h.workspace_id=g.workspace_id AND h.grant_id=g.id AND h.released_at IS NULL),0)`
        : '0'
      const packGrants = await client.query<{orderId:string;sku:CommercialCatalogSkuSnapshot;expiresAt:string|null;paidAt:string|null;grantStatus:CommercialGrantStatusV3}>(`SELECT o.id AS "orderId",s.snapshot->'sku' AS sku,g.expires_at AS "expiresAt",o.paid_at AS "paidAt",t.grant_status AS "grantStatus"
        FROM creative_point_grants g
        JOIN commercial_orders_v2 o ON o.workspace_id=g.workspace_id AND o.id=g.source_id AND o.status='paid'
        JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id
        LEFT JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id
        LEFT JOIN (SELECT workspace_id,grant_id,sum(points_delta) AS points FROM creative_point_allocations WHERE workspace_id=$1 GROUP BY workspace_id,grant_id) a ON a.workspace_id=g.workspace_id AND a.grant_id=g.id
        WHERE g.workspace_id=$1 AND g.source_type='commercial_order_v2' AND s.snapshot->'sku'->>'kind'='point_pack'
          AND (g.expires_at IS NULL OR g.expires_at>$2::timestamptz)
          AND GREATEST(g.points-COALESCE(a.points,0)-${heldPoints},0)>0
        ORDER BY o.paid_at DESC,o.id DESC`,[workspaceId,at])
      const packs = packGrants.rows.map(row => ({ orderId: row.orderId, skuCode: row.sku.code, skuVersionId: row.sku.versionId, benefits: row.sku.benefits, expiresAt: row.expiresAt ? iso(row.expiresAt) : null, paidAt: row.paidAt ? iso(row.paidAt) : null, grantStatus: row.grantStatus }))
      return { onboardingQualified: qualification.qualified, qualification, current: current[0] ?? null,
        future: snapshots.filter(row => row.periodStatus === 'active' && row.sourceOrderStatus === 'paid' && Date.parse(row.periodStart) > Date.parse(at)),
        history: snapshots.filter(row => Date.parse(row.periodEnd) <= Date.parse(at) || row.periodStatus !== 'active' || row.sourceOrderStatus !== 'paid'), packs, orders: orderResult.rows.map(mapOrder) }
    })
  }

  private async outbox(client: SqlClient, workspaceId: string, aggregateId: string, event: string, payload: unknown, at: string): Promise<void> {
    await client.query(`INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload,created_at) VALUES($1,$2,$3,$4,1,$5::jsonb,$6::timestamptz) ON CONFLICT(workspace_id,aggregate_id,event_type,sequence) DO NOTHING`, [id('evt'), workspaceId, aggregateId, event, JSON.stringify(payload), at])
  }
}
