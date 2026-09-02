/**
 * Policy-free service fulfillment orchestration.
 *
 * This module intentionally does not calculate SLA deadlines, round time,
 * charge for cancellation/no-show, infer refund eligibility, or activate the
 * six onboarding grants. Those policies are unresolved in the source PRD.
 */

export const ONBOARDING_GRANT_COUNT = 6 as const
export const ONBOARDING_GRANT_POINTS = 500 as const

export type ServiceFulfillmentEventType = 'scheduled' | 'started' | 'completed' | 'cancelled' | 'adjusted'
export type ServiceFulfillmentStatus = 'allocated' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled'

export interface OnboardingGrantScheduleDraft {
  naturalKey: string
  workspaceId: string
  onboardingOrderId: string
  entitlementSnapshotId: string
  sequence: number
  points: 500
  dueAt: null
  expiresAt: null
  status: 'unresolved'
  blockers: readonly ['ONBOARDING_GRANT_START_DATE_UNRESOLVED', 'ONBOARDING_GRANT_EXPIRY_RULE_UNRESOLVED']
}

export const STANDARD_ONBOARDING_PLATFORMS = ['taobao', 'tmall', 'jd', 'pinduoduo', 'douyin', 'xiaohongshu'] as const
export type StandardOnboardingPlatform = typeof STANDARD_ONBOARDING_PLATFORMS[number]

export interface OnboardingDeliveryChecklistDraft {
  itemCode: string
  unit: 'count' | 'contract_label'
  quantity: number | null
  contractLabel: string | null
  status: 'allocated' | 'unresolved'
  blockers: string[]
  supportedPlatforms: StandardOnboardingPlatform[]
  sourceChecksum: string
}

export interface ServiceAllocation {
  id: string
  workspaceId: string
  orderSnapshotId: string
  entitlementSnapshotId: string
  serviceType: string
  unit: 'count' | 'minute' | 'contract_label'
  allocatedQuantity: number | null
  contractLabel: string | null
  periodStart: string | null
  periodEnd: string | null
  revision: number
  status: ServiceFulfillmentStatus
  usedQuantity: number
}

export interface ServiceFulfillmentEvent {
  id: string
  workspaceId: string
  allocationId: string
  type: ServiceFulfillmentEventType
  revision: number
  idempotencyKey: string
  actorId: string
  reason: string
  scheduleAt: string | null
  actualQuantity: number | null
  correctsEventId: string | null
  evidence: Record<string, unknown>
  createdAt: string
}

export interface RecordServiceFulfillmentInput {
  workspaceId: string
  allocationId: string
  type: ServiceFulfillmentEventType
  expectedRevision: number
  idempotencyKey: string
  actorId: string
  reason: string
  scheduleAt?: string | null
  actualQuantity?: number | null
  correctsEventId?: string | null
  evidence?: Record<string, unknown>
}

export interface CreateServiceAllocationCommand {
  workspaceId: string
  expectedRevision: 0
  idempotencyKey: string
  actorId: string
  reason: string
  orderSnapshotId: string
  entitlementSnapshotId: string
  serviceType: string
  unit: 'count' | 'minute' | 'contract_label'
  allocatedQuantity?: number | null
  contractLabel?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  sourceChecksum: string
  evidence: Record<string, unknown>
}

export interface ServiceFulfillmentRepositoryPort {
  createAllocation(input: CreateServiceAllocationCommand): Promise<ServiceAllocation>
  appendEvent(input: RecordServiceFulfillmentInput): Promise<{ allocation: ServiceAllocation; event: ServiceFulfillmentEvent }>
}

export interface ServiceAccessPort {
  decide(input: { workspaceId: string; operation: 'service.fulfillment.record' }): Promise<{
    balanceState: 'known' | 'unknown'
    availablePoints: number | null
    allowed: boolean
    accessRevision: string | null
  }>
}

export interface ServiceAuthorizationPort {
  authorize(input: { workspaceId: string; actorId: string; capability: 'commercial.service_fulfillment.write' }): Promise<boolean>
}

export type ServiceFulfillmentErrorCode =
  | 'SERVICE_FULFILLMENT_INPUT_INVALID'
  | 'SERVICE_FULFILLMENT_PERMISSION_DENIED'
  | 'CREATIVE_POINTS_EXHAUSTED'
  | 'CREATIVE_POINTS_UNAVAILABLE'

export class ServiceFulfillmentError extends Error {
  constructor(readonly code: ServiceFulfillmentErrorCode, message: string) {
    super(message)
    this.name = 'ServiceFulfillmentError'
  }
}

const required = (value: string, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', `${field} is required`)
  }
  return value.trim()
}

const positiveRevision = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'expectedRevision must be positive')
  return value
}

const optionalQuantity = (value: number | null | undefined): number | null => {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'actualQuantity must be a non-negative integer')
  return value
}

const optionalInstant = (value: string | null | undefined): string | null => {
  if (value == null) return null
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'scheduleAt must be a canonical ISO timestamp')
  }
  return value
}

const evidence = (value: Record<string, unknown> | undefined): Record<string, unknown> => {
  const result = value ?? {}
  if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result), 'utf8') > 32_768) {
    throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'evidence must be a bounded object')
  }
  return structuredClone(result)
}

/**
 * Produces the only safe schedule while start/expiry policy is unresolved.
 * It is a six-row draft with no executable timestamps, never six grants.
 */
export function planOnboardingGrantSchedule(input: {
  workspaceId: string
  onboardingOrderId: string
  entitlementSnapshotId: string
}): OnboardingGrantScheduleDraft[] {
  const workspaceId = required(input.workspaceId, 'workspaceId')
  const onboardingOrderId = required(input.onboardingOrderId, 'onboardingOrderId')
  const entitlementSnapshotId = required(input.entitlementSnapshotId, 'entitlementSnapshotId')
  return Array.from({ length: ONBOARDING_GRANT_COUNT }, (_, index) => ({
    naturalKey: `${onboardingOrderId}:onboarding_grant:${index + 1}`,
    workspaceId,
    onboardingOrderId,
    entitlementSnapshotId,
    sequence: index + 1,
    points: ONBOARDING_GRANT_POINTS,
    dueAt: null,
    expiresAt: null,
    status: 'unresolved' as const,
    blockers: ['ONBOARDING_GRANT_START_DATE_UNRESOLVED', 'ONBOARDING_GRANT_EXPIRY_RULE_UNRESOLVED'] as const,
  }))
}

/** Builds only source-listed onboarding deliverables from a verified snapshot. */
export function planOnboardingDeliveryChecklist(input: {
  sourceChecksum: string
  maxBrands: number
  maxStores: number
  maxProducts: number | null
  platforms: readonly StandardOnboardingPlatform[]
}): OnboardingDeliveryChecklistDraft[] {
  if (!/^[a-f0-9]{64}$/u.test(input.sourceChecksum)) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'sourceChecksum is invalid')
  for (const [field, value] of [['maxBrands', input.maxBrands], ['maxStores', input.maxStores]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', `${field} must be positive`)
  }
  if (input.maxProducts !== null && (!Number.isSafeInteger(input.maxProducts) || input.maxProducts < 1)) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'maxProducts must be positive or unresolved')
  const platforms = [...new Set(input.platforms)]
  if (!platforms.length || platforms.some(platform => !STANDARD_ONBOARDING_PLATFORMS.includes(platform))) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'platforms must be a non-empty subset of the six source platforms')
  const fixed = (itemCode: string, quantity = 1): OnboardingDeliveryChecklistDraft => ({ itemCode, unit: 'count', quantity, contractLabel: null, status: 'allocated', blockers: [], supportedPlatforms: platforms, sourceChecksum: input.sourceChecksum })
  return [
    fixed('plugin_account_activation'),
    fixed('system_deployment_and_basic_debugging'),
    fixed('platform_fixed_rule_configuration'),
    fixed('product_category_rule_configuration'),
    fixed('campaign_milestone_rule_configuration'),
    fixed('system_usage_training'),
    fixed('launch_acceptance'),
    { itemCode: 'basic_issue_handling', unit: 'contract_label', quantity: null, contractLabel: '基础问题处理', status: 'allocated', blockers: [], supportedPlatforms: platforms, sourceChecksum: input.sourceChecksum },
    fixed('user_preference_initial_entry'),
    fixed('enterprise_entity_initial_entry'),
    fixed('store_initial_scan_entry', input.maxStores),
    input.maxProducts === null
      ? { itemCode: 'product_initial_scan_entry', unit: 'contract_label', quantity: null, contractLabel: '按已购月度套餐上限；产品数量上限未解析', status: 'unresolved', blockers: ['PRODUCT_INITIAL_IMPORT_LIMIT_UNRESOLVED'], supportedPlatforms: platforms, sourceChecksum: input.sourceChecksum }
      : fixed('product_initial_scan_entry', input.maxProducts),
    fixed('brand_asset_initial_entry', input.maxBrands),
    fixed('brand_expression_visual_initial_entry', input.maxBrands),
  ]
}

export class ServiceFulfillmentService {
  constructor(
    private readonly repository: ServiceFulfillmentRepositoryPort,
    private readonly access: ServiceAccessPort,
    private readonly authorization: ServiceAuthorizationPort,
  ) {}

  async create(input: CreateServiceAllocationCommand): Promise<{ allocation: ServiceAllocation; accessRevision: string }> {
    if (input.expectedRevision !== 0) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'new allocation requires expectedRevision 0')
    const normalized: CreateServiceAllocationCommand = {
      ...input,
      workspaceId: required(input.workspaceId, 'workspaceId'),
      idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
      actorId: required(input.actorId, 'actorId'),
      reason: required(input.reason, 'reason'),
      orderSnapshotId: required(input.orderSnapshotId, 'orderSnapshotId'),
      entitlementSnapshotId: required(input.entitlementSnapshotId, 'entitlementSnapshotId'),
      serviceType: required(input.serviceType, 'serviceType'),
      sourceChecksum: required(input.sourceChecksum, 'sourceChecksum'),
      evidence: evidence(input.evidence),
    }
    if (!/^[a-f0-9]{64}$/u.test(normalized.sourceChecksum) || Object.keys(normalized.evidence).length === 0) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'verified source checksum and evidence are required')
    const authorized = await this.authorization.authorize({ workspaceId: normalized.workspaceId, actorId: normalized.actorId, capability: 'commercial.service_fulfillment.write' })
    if (!authorized) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_PERMISSION_DENIED', 'service fulfillment capability is required')
    const decision = await this.access.decide({ workspaceId: normalized.workspaceId, operation: 'service.fulfillment.record' })
    if (decision.balanceState === 'unknown' || decision.availablePoints === null || !decision.accessRevision) throw new ServiceFulfillmentError('CREATIVE_POINTS_UNAVAILABLE', 'creative point balance is unavailable')
    if (!decision.allowed || decision.availablePoints <= 0) throw new ServiceFulfillmentError('CREATIVE_POINTS_EXHAUSTED', 'positive creative points are required for service fulfillment')
    return { allocation: await this.repository.createAllocation(normalized), accessRevision: decision.accessRevision }
  }

  async record(input: RecordServiceFulfillmentInput): Promise<{ allocation: ServiceAllocation; event: ServiceFulfillmentEvent; accessRevision: string }> {
    const normalized: RecordServiceFulfillmentInput = {
      workspaceId: required(input.workspaceId, 'workspaceId'),
      allocationId: required(input.allocationId, 'allocationId'),
      type: input.type,
      expectedRevision: positiveRevision(input.expectedRevision),
      idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
      actorId: required(input.actorId, 'actorId'),
      reason: required(input.reason, 'reason'),
      scheduleAt: optionalInstant(input.scheduleAt),
      actualQuantity: optionalQuantity(input.actualQuantity),
      correctsEventId: input.correctsEventId ? required(input.correctsEventId, 'correctsEventId') : null,
      evidence: evidence(input.evidence),
    }
    if (!['scheduled', 'started', 'completed', 'cancelled', 'adjusted'].includes(normalized.type)) {
      throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'event type is invalid')
    }
    if (normalized.type === 'scheduled' && normalized.scheduleAt === null) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'scheduled event requires scheduleAt')
    if (Object.keys(normalized.evidence ?? {}).length === 0) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'fulfillment event requires evidence')
    if (normalized.type === 'adjusted' && (!normalized.correctsEventId || normalized.actualQuantity === null)) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_INPUT_INVALID', 'adjusted event requires target and corrected quantity')

    const authorized = await this.authorization.authorize({ workspaceId: normalized.workspaceId, actorId: normalized.actorId, capability: 'commercial.service_fulfillment.write' })
    if (!authorized) throw new ServiceFulfillmentError('SERVICE_FULFILLMENT_PERMISSION_DENIED', 'service fulfillment capability is required')

    const decision = await this.access.decide({ workspaceId: normalized.workspaceId, operation: 'service.fulfillment.record' })
    if (decision.balanceState === 'unknown' || decision.availablePoints === null || !decision.accessRevision) {
      throw new ServiceFulfillmentError('CREATIVE_POINTS_UNAVAILABLE', 'creative point balance is unavailable')
    }
    if (!decision.allowed || decision.availablePoints <= 0) {
      throw new ServiceFulfillmentError('CREATIVE_POINTS_EXHAUSTED', 'positive creative points are required for service fulfillment')
    }

    const result = await this.repository.appendEvent(normalized)
    return { ...result, accessRevision: decision.accessRevision }
  }
}
