import { createHash } from 'node:crypto'
import { isSecureEnvironment } from '../../connectors/src/outbound-security.js'

export type RelayUsageModality = 'text' | 'image' | 'image_edit' | 'ocr' | 'video' | 'embedding'

export interface RelayUsageContext {
  workspaceId?: string
  actionId?: string
  /** Stable logical task identity shared by all provider calls in one budget run. */
  runKey?: string
  contextLinkId?: string
  contextHash?: string
  /** Count of usable image artifacts parsed from the provider response; diagnostic only. */
  observedArtifactCount?: number
  resolution?: string
  /** Request-side estimate used for budget preauthorization, never settlement. */
  preauthorizationDurationSeconds?: number
  /** @deprecated Use preauthorizationDurationSeconds for request-side estimates. */
  durationSeconds?: number
  /** Stable identity of this exact provider call when no provider request ID is returned. */
  providerAttemptId?: string
}

export interface RelayUsageRecord {
  workspaceId?: string
  actionId?: string
  runKey?: string
  contextLinkId?: string
  contextHash?: string
  modality: RelayUsageModality
  model: string
  providerRequestId?: string
  providerAttemptId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costCny?: number
  observedAt: string
  metadata?: Record<string, unknown>
}

export type RelayUsageSettlement = 'recorded' | 'unknown'

export interface RelayUsageSettlementReceipt {
  recorded: true
  /** The settlement boundary verified provider or versioned derived cost. */
  costEvidence: true
}

export type RelayUsageSink = (record: RelayUsageRecord) => void | RelayUsageSettlementReceipt | Promise<void | RelayUsageSettlementReceipt>

export class ModelUsageSettlementPendingError extends Error {
  readonly code = 'MODEL_USAGE_SETTLEMENT_PENDING'
  readonly providerSucceeded = true

  constructor(readonly receiptKey: string) {
    super('model usage settlement is pending')
    this.name = 'ModelUsageSettlementPendingError'
  }
}

export class ModelUsageReceiptIdentityError extends Error {
  readonly code = 'MODEL_USAGE_RECEIPT_IDENTITY_MISSING'
  readonly providerSucceeded = true

  constructor() {
    super('model usage receipt is missing provider request and attempt identity')
    this.name = 'ModelUsageReceiptIdentityError'
  }
}

export class ModelUsageEvidenceMissingError extends Error {
  readonly code = 'MODEL_USAGE_EVIDENCE_MISSING'
  readonly providerSucceeded = true
  readonly providerRequestId?: string

  constructor(readonly missing: 'usage' | 'cost' | 'sink' | 'identity', evidence?: Pick<RelayUsageRecord, 'providerRequestId'>) {
    super(`model usage ${missing} evidence is missing`)
    this.name = 'ModelUsageEvidenceMissingError'
    this.providerRequestId = evidence?.providerRequestId
  }
}

/** Production model calls must have a durable settlement sink before dispatch. */
export function assertUsageSinkConfiguredBeforeDispatch(sink: RelayUsageSink | undefined, environment: string | undefined = process.env.NODE_ENV): void {
  if (isSecureEnvironment(environment) && !sink) throw new ModelUsageEvidenceMissingError('sink')
}

type RecordLike = Record<string, unknown>

function record(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// These identifiers cross into billing, audit and reconciliation evidence.
// Bound and sanitize them before accepting provider-controlled values so a
// response cannot inject control characters or create unbounded evidence rows.
function evidenceIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number') return finiteNonNegative(value)
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())) return finiteNonNegative(Number(value))
  return undefined
}

function tokenFrom(value: unknown): number | undefined {
  const parsed = numberFrom(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberFrom(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export function relayUsageReceiptKey(usage: Pick<RelayUsageRecord, 'workspaceId' | 'actionId' | 'model' | 'modality' | 'providerRequestId' | 'providerAttemptId'>) {
  const providerRequestId = evidenceIdentity(usage.providerRequestId)
  const providerAttemptId = evidenceIdentity(usage.providerAttemptId)
  if (!providerRequestId && !providerAttemptId) throw new ModelUsageReceiptIdentityError()
  // Preserve the provider request ID as the externally reconcilable receipt.
  // Persistence uniqueness is workspace-scoped and separately validates all
  // immutable receipt facts, so cross-tenant IDs cannot collide silently.
  if (providerRequestId) return providerRequestId
  // A local attempt has no externally meaningful identity, so bind it to the
  // trusted tenant/action/model/modality context before persisting it.
  const identity = JSON.stringify([
    usage.workspaceId?.trim() ?? '',
    usage.actionId?.trim() ?? '',
    usage.model.trim(),
    usage.modality,
    ['provider_attempt', providerAttemptId],
  ])
  return `relay_usage_${createHash('sha256').update(identity, 'utf8').digest('hex')}`
}

/** Extract the provider-neutral usage shape without trusting arbitrary response fields. */
export function parseRelayUsage(payload: unknown, headers: Headers, defaults: { modality: RelayUsageModality; model: string; context?: RelayUsageContext }): RelayUsageRecord | undefined {
  const root = record(payload) ? payload : {}
  const data = record(root.data) ? root.data : undefined
  const nestedData = data && record(data.data) ? data.data : undefined
  // Some local/API relay adapters preserve the common API envelope and put
  // the provider response below data.result. Keep this explicit and bounded;
  // arbitrary recursive traversal could accidentally treat unrelated data as
  // metering evidence.
  const result = data && record(data.result) ? data.result : undefined
  const metadata = record(root.metadata) ? root.metadata : undefined
  const usageEnvelopes = [root, data, nestedData, result, metadata].filter(record)
  // An explicitly present but malformed usage envelope is a provider claim,
  // not an absent optional envelope. Do not silently discard it when another
  // supported envelope happens to contain a parseable receipt.
  const malformedUsageEnvelope = usageEnvelopes.some(node =>
    Object.prototype.hasOwnProperty.call(node, 'usage') && !record(node.usage))
  // Validate every explicitly supported usage envelope. Some relays wrap an
  // upstream response while retaining its original `usage` beside the
  // normalized top-level usage; choosing only the first object could let a
  // conflicting nested receipt silently pass settlement.
  const usageNodes = [root.usage, data?.usage, nestedData?.usage, result?.usage, metadata?.usage].filter(record)
  const usage = usageNodes[0]
  const rawInputTokenFields = usageNodes.flatMap(node => [node.prompt_tokens, node.input_tokens, node.inputTokens]).filter(value => value !== undefined)
  const rawOutputTokenFields = usageNodes.flatMap(node => [node.completion_tokens, node.output_tokens, node.outputTokens]).filter(value => value !== undefined)
  const rawTotalTokenFields = usageNodes.flatMap(node => [node.total_tokens, node.totalTokens]).filter(value => value !== undefined)
  const inputTokenAliases = rawInputTokenFields.map(tokenFrom)
  const outputTokenAliases = rawOutputTokenFields.map(tokenFrom)
  const totalTokenAliases = rawTotalTokenFields.map(tokenFrom)
  const tokenAliasesInvalid = (values: Array<number | undefined>) =>
    values.some(value => value === undefined) || new Set(values).size > 1
  const inputTokenAliasesInvalid = tokenAliasesInvalid(inputTokenAliases)
  const outputTokenAliasesInvalid = tokenAliasesInvalid(outputTokenAliases)
  const totalTokenAliasesInvalid = tokenAliasesInvalid(totalTokenAliases)
  const inputTokens = tokenFrom(usage?.prompt_tokens) ?? tokenFrom(usage?.input_tokens) ?? tokenFrom(usage?.inputTokens)
  const reportedOutputTokens = tokenFrom(usage?.completion_tokens) ?? tokenFrom(usage?.output_tokens) ?? tokenFrom(usage?.outputTokens)
  const reportedTotal = tokenFrom(usage?.total_tokens) ?? tokenFrom(usage?.totalTokens)
  // Some embedding relays report prompt_tokens and total_tokens but omit the
  // completion field. Embeddings produce no completion tokens; record zero
  // only when the provider's total exactly equals its reported input. Do not
  // infer from a missing total, an inconsistent total, or malformed explicit
  // output field. The metadata keeps this mathematical derivation auditable.
  const outputTokensDerivedFromEmbeddingTotal = defaults.modality === 'embedding'
    && reportedOutputTokens === undefined
    && rawOutputTokenFields.every(value => value === undefined)
    && inputTokens !== undefined
    && reportedTotal !== undefined
    && reportedTotal === inputTokens
  const outputTokens = reportedOutputTokens ?? (outputTokensDerivedFromEmbeddingTotal ? 0 : undefined)
  const totalTokens = reportedTotal !== undefined && inputTokens !== undefined && outputTokens !== undefined && reportedTotal !== inputTokens + outputTokens
    ? undefined
    : reportedTotal ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  const tokenTotalMismatch = reportedTotal !== undefined && inputTokens !== undefined && outputTokens !== undefined && reportedTotal !== inputTokens + outputTokens
  const tokenEvidenceInvalid = inputTokenAliasesInvalid || outputTokenAliasesInvalid || totalTokenAliasesInvalid || tokenTotalMismatch
  // Raw quota is deliberately excluded: without a versioned unit, exchange
  // rate and pricing formula it is not currency evidence. Explicit provider
  // cost fields are financial evidence: malformed values or a non-CNY
  // currency must invalidate the receipt instead of being silently ignored
  // and replaced by a derived estimate downstream.
  const costNodes = [...usageNodes, root, data, nestedData, result, metadata].filter((value): value is RecordLike => Boolean(value))
  const costKeys = ['cost_cny', 'costCny', 'actual_cost_cny', 'actualCostCny'] as const
  const explicitCost = costNodes.flatMap(node => costKeys.filter(key => Object.prototype.hasOwnProperty.call(node, key)).map(key => node[key]))
  const explicitCurrency = costNodes.flatMap(node => ['currency', 'cost_currency', 'costCurrency'].filter(key => Object.prototype.hasOwnProperty.call(node, key)).map(key => node[key]))
  if ((explicitCurrency.length > 0 && explicitCost.length === 0)
    || explicitCost.some(value => firstNumber(value) === undefined)
    || explicitCurrency.some(value => {
      if (typeof value !== 'string' || !value.trim()) return true
      return value.trim().toUpperCase() !== 'CNY'
    })) return undefined
  const costCny = explicitCost.length > 0 ? firstNumber(...explicitCost) : undefined
  if (explicitCost.some(value => firstNumber(value) !== costCny)) return undefined
  const imageResultObserved = (defaults.modality === 'image' || defaults.modality === 'image_edit') && (
    (Array.isArray(root.data) && root.data.length > 0)
    || (Array.isArray(root.images) && root.images.length > 0)
    || (data && Array.isArray(data.data) && data.data.length > 0)
    || (data && Array.isArray(data.images) && data.images.length > 0)
    || (result && Array.isArray(result.data) && result.data.length > 0)
  )
  // OpenAI-compatible image responses may put the provider request ID in
  // the response body instead of a header. Accept body IDs only when this is
  // an image response with actual artifacts; never use a generic text `id` as
  // settlement identity.
  const imageBodyRequestId = imageResultObserved
    ? evidenceIdentity(root.id) || evidenceIdentity(data?.id)
    : undefined
  const providerRequestId = evidenceIdentity(headers.get('x-oneapi-request-id'))
    || evidenceIdentity(headers.get('x-request-id'))
    || evidenceIdentity(headers.get('x-provider-request-id'))
    || evidenceIdentity(headers.get('request-id'))
    || evidenceIdentity(root.provider_request_id)
    || evidenceIdentity(root.request_id)
    || evidenceIdentity(data?.provider_request_id)
    || evidenceIdentity(data?.request_id)
    || evidenceIdentity(nestedData?.provider_request_id)
    || evidenceIdentity(nestedData?.request_id)
    || evidenceIdentity(result?.provider_request_id)
    || evidenceIdentity(result?.request_id)
    || evidenceIdentity(metadata?.provider_request_id)
    || evidenceIdentity(metadata?.request_id)
    || imageBodyRequestId
  // Cost is not usage. A relay that reports only a price has not provided
  // enough metering evidence to settle a model call safely.
  // Image relays commonly meter by generated image units rather than tokens.
  // Only a positive provider-reported usage count is billing evidence; parsed
  // artifacts are diagnostic and never substitute for provider usage.
  // OpenAI-compatible relays generally expose `output_image_count`, while
  // DashScope/Qwen reports the same provider-observed quantity as
  // `usage.image_count`. New API preserves that upstream usage object in its
  // response metadata. Both are provider-reported metering evidence; neither
  // is inferred from the requested or returned artifact count.
  const rawOutputImageCounts = [
    ...usageNodes.flatMap(node => [node.output_image_count, node.outputImageCount, node.image_count, node.imageCount]),
    root.output_image_count,
    root.outputImageCount,
    root.image_count,
    root.imageCount,
    data?.output_image_count,
    data?.outputImageCount,
    data?.image_count,
    data?.imageCount,
    result?.output_image_count,
    result?.outputImageCount,
    result?.image_count,
    result?.imageCount,
    metadata?.output_image_count,
    metadata?.outputImageCount,
    metadata?.image_count,
    metadata?.imageCount,
  ].filter(value => value !== undefined)
  const parsedOutputImageCounts = rawOutputImageCounts.map(tokenFrom)
  const imageCountEvidenceInvalid = parsedOutputImageCounts.some(value => value === undefined || value <= 0)
    || new Set(parsedOutputImageCounts).size > 1
  const reportedOutputImageCount = parsedOutputImageCounts.find((value): value is number => value !== undefined)
  const reportedOutputImageCountValid = !imageCountEvidenceInvalid && (rawOutputImageCounts.length === 0 || reportedOutputImageCount !== undefined)
  const observedArtifactCount = defaults.context?.observedArtifactCount
  const observedArtifactCountValid = observedArtifactCount !== undefined && Number.isSafeInteger(observedArtifactCount) && observedArtifactCount >= 0
  const imageArtifactCountMismatch = reportedOutputImageCount !== undefined && observedArtifactCountValid && reportedOutputImageCount !== observedArtifactCount
  // New API/DashScope video responses use `duration` (and in some
  // responses `output_video_duration`) for the provider-observed duration.
  // Treat these as equivalent provider evidence; they are not the request
  // estimate and must remain distinct from preauthorizationDurationSeconds.
  const rawProviderDurations = usageNodes.flatMap(node => [node.duration_seconds, node.durationSeconds, node.duration, node.output_video_duration, node.outputVideoDuration]).filter(value => value !== undefined)
  const parsedProviderDurations = rawProviderDurations.map(numberFrom)
  const parsedProviderDurationSeconds = firstNumber(...rawProviderDurations)
  // These aliases describe the same billed duration. A malformed explicit
  // field or conflicting value cannot be skipped in favor of a cheaper
  // alias (or token count), even when the provider also reports actual cost.
  // Compare parsed numbers so "3.50" and 3.5 remain equivalent evidence.
  const providerDurationEvidenceInvalid = defaults.modality === 'video'
    && parsedProviderDurations.some(value => value === undefined || value <= 0 || value !== parsedProviderDurationSeconds)
  const providerDurationSeconds = !providerDurationEvidenceInvalid && parsedProviderDurationSeconds !== undefined && parsedProviderDurationSeconds > 0 ? parsedProviderDurationSeconds : undefined
  // Artifact arrays may identify a body request ID, but never prove billed
  // image units by themselves.
  const videoEvidenceNode = data ?? result ?? nestedData ?? root
  // A generic response `id` is not proof that a video job was accepted: chat
  // style relays often echo an id even when no render was queued. Accept it
  // only with an explicit async lifecycle status; task_id/job_id remain
  // bounded identifiers regardless of status. This covers both the legacy
  // `{data:{id,status}}` envelope and the newer `task_status` response.
  const explicitVideoJobIdValue = videoEvidenceNode
    ? ['task_id', 'job_id'].map(key => evidenceIdentity(videoEvidenceNode[key])).find((value): value is string => Boolean(value))
    : undefined
  const explicitVideoJobId = Boolean(explicitVideoJobIdValue)
  const videoStatus = typeof videoEvidenceNode?.status === 'string' ? videoEvidenceNode.status : typeof videoEvidenceNode?.task_status === 'string' ? videoEvidenceNode.task_status : undefined
  const acceptedVideoStatuses = new Set(['queued', 'pending', 'created', 'submitted', 'processing', 'running', 'in_progress'])
  const statusBoundVideoIdValue = typeof videoStatus === 'string' && acceptedVideoStatuses.has(videoStatus.toLowerCase()) ? evidenceIdentity(videoEvidenceNode?.id) : undefined
  const statusBoundVideoId = Boolean(statusBoundVideoIdValue)
  const videoRequestAccepted = defaults.modality === 'video' && Boolean(providerRequestId || defaults.context?.providerAttemptId) && (explicitVideoJobId || statusBoundVideoId)
  // The durable provider job id of an accepted video request, whichever
  // envelope carried it. Persisting it keeps a queued (and possibly billed)
  // job reconcilable even when its usage cannot be settled locally.
  const videoJobId = defaults.modality === 'video' && videoRequestAccepted ? explicitVideoJobIdValue ?? statusBoundVideoIdValue : undefined
  const imageModality = defaults.modality === 'image' || defaults.modality === 'image_edit'
  const usageObserved = !malformedUsageEnvelope && !providerDurationEvidenceInvalid && (imageModality
    ? rawOutputImageCounts.length > 0 && reportedOutputImageCountValid && reportedOutputImageCount !== undefined
    : !tokenEvidenceInvalid && (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined || providerDurationSeconds !== undefined))
  const preauthorizationDurationSeconds = defaults.context?.preauthorizationDurationSeconds ?? defaults.context?.durationSeconds
  return {
    ...(defaults.context?.workspaceId ? { workspaceId: defaults.context.workspaceId } : {}),
    ...(defaults.context?.actionId ? { actionId: defaults.context.actionId } : {}),
    ...(defaults.context?.runKey ? { runKey: defaults.context.runKey } : {}),
    ...(defaults.context?.contextLinkId ? { contextLinkId: defaults.context.contextLinkId } : {}),
    ...(defaults.context?.contextHash ? { contextHash: defaults.context.contextHash } : {}),
    modality: defaults.modality,
    model: defaults.model,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(defaults.context?.providerAttemptId?.trim() ? { providerAttemptId: defaults.context.providerAttemptId.trim() } : {}),
    // Image receipts may still be settled from independent provider-reported
    // image units or an actual CNY cost. Do not carry contradictory token
    // aliases into the sink, where a token-priced model could use them to
    // derive cost or persist them as accounting evidence.
    ...(!inputTokenAliasesInvalid && inputTokens !== undefined ? { inputTokens } : {}),
    ...(!outputTokenAliasesInvalid && outputTokens !== undefined ? { outputTokens } : {}),
    ...(!totalTokenAliasesInvalid && !tokenTotalMismatch && totalTokens !== undefined ? { totalTokens } : {}),
    ...(costCny !== undefined ? { costCny } : {}),
    observedAt: new Date().toISOString(),
    metadata: {
      usage_observed: usageObserved,
      ...(malformedUsageEnvelope ? { malformed_usage_envelope: true } : {}),
      ...(tokenEvidenceInvalid ? { token_evidence_invalid: true } : {}),
      ...(outputTokensDerivedFromEmbeddingTotal ? { output_tokens_derivation: 'embedding_total_equals_prompt_tokens' } : {}),
      ...(videoRequestAccepted ? { video_request_accepted: true } : {}),
      // Persist the relay's durable video job id. When settlement cannot be
      // recorded the usage receipt is still the only durable record of the
      // call, and without this id the queued (possibly billed) provider job
      // has no reconcilable identity anywhere in the ledger.
      ...(videoJobId ? { provider_job_id: videoJobId } : {}),
      ...(imageModality && !imageCountEvidenceInvalid && reportedOutputImageCount !== undefined ? { billing_units: reportedOutputImageCount, billing_units_evidence: 'provider_usage' } : {}),
      ...(imageModality && imageCountEvidenceInvalid ? { billing_units_evidence_invalid: true } : {}),
      ...(imageModality && observedArtifactCountValid ? { observed_artifact_count: observedArtifactCount } : {}),
      ...(imageModality && imageArtifactCountMismatch ? { artifact_count_mismatch: true } : {}),
      ...(defaults.context?.resolution ? { resolution: defaults.context.resolution } : {}),
      ...(providerDurationEvidenceInvalid ? { duration_evidence_invalid: true } : {}),
      ...(providerDurationSeconds !== undefined ? { duration_seconds: providerDurationSeconds, duration_evidence: 'provider_usage' } : {}),
      ...(preauthorizationDurationSeconds ? { preauthorization_duration_seconds: preauthorizationDurationSeconds, preauthorization_estimate: true } : {}),
      ...(typeof root.id === 'string' && root.id.trim() ? { provider_response_id: root.id.trim() } : {}),
    },
  }
}

export async function emitRelayUsage(sink: RelayUsageSink | undefined, payload: unknown, headers: Headers, defaults: { modality: RelayUsageModality; model: string; context?: RelayUsageContext }) {
  const usage = parseRelayUsage(payload, headers, defaults)
  if (!usage || usage.metadata?.usage_observed !== true) throw new ModelUsageEvidenceMissingError('usage', usage)
  if (!usage.providerRequestId?.trim() && !usage.providerAttemptId?.trim()) throw new ModelUsageEvidenceMissingError('identity', usage)
  if (!sink) throw new ModelUsageEvidenceMissingError('sink', usage)
  let settlementReceipt: void | RelayUsageSettlementReceipt
  try {
    settlementReceipt = await sink(usage)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      const code = (error as { code?: unknown })?.code
      const message = error instanceof Error ? error.message : String(error)
      console.error('[model-usage-settlement]', code ?? 'UNKNOWN', message)
    }
    if (['MODEL_USAGE_COST_MISSING', 'MODEL_TASK_COST_ACTUAL_EXCEEDED', 'MODEL_DAILY_COST_ACTUAL_EXCEEDED'].includes(String((error as { code?: unknown })?.code ?? ''))) throw error
    throw new ModelUsageSettlementPendingError(relayUsageReceiptKey(usage))
  }
  // A sink may be implemented outside this package (or arrive through a
  // JavaScript boundary), so the TypeScript receipt type is not enough at
  // runtime. Never turn a malformed receipt into a successful settlement.
  if (settlementReceipt === undefined || settlementReceipt.recorded !== true || settlementReceipt.costEvidence !== true) {
    // Prefer the actionable financial-evidence diagnostic when the provider
    // omitted currency; settlement is still rejected below this boundary.
    if (settlementReceipt === undefined && usage.costCny === undefined) throw new ModelUsageEvidenceMissingError('cost', usage)
    throw new ModelUsageEvidenceMissingError('sink', usage)
  }
  // Some relays return tokens but omit currency. Only a trusted settlement
  // sink may fill that gap from a versioned pricing snapshot; a plain sink
  // success is not sufficient cost evidence.
  // A cost attestation is only meaningful when the sink also confirms that
  // the usage record was durably recorded. Do not let a malformed or stale
  // adapter response turn derived pricing into a successful settlement.
  const settlementRecorded = settlementReceipt.recorded === true
  if (usage.costCny === undefined && (!settlementRecorded || settlementReceipt.costEvidence !== true)) throw new ModelUsageEvidenceMissingError('cost', usage)
  usage.metadata = { ...(usage.metadata ?? {}), ...(usage.costCny === undefined ? { cost_evidence: 'settlement_sink' } : {}), settlement: 'recorded' satisfies RelayUsageSettlement }
  return usage
}
