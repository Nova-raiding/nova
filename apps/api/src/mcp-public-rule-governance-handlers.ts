import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { PersistedRuleAudit, PersistedRuleVersion, PublicRuleReviewCursor } from '../../../packages/persistence/src/index.js'
import type { RuleRepositoryPort } from './server.js'

type JsonObject = Record<string, unknown>
type ReviewerPrincipal = { actorId: string; workbench: string }

export interface PublicRuleGovernanceDependencies {
  result: (value: unknown) => unknown
  required: (params: JsonObject, key: string) => string
  ruleRepository: () => RuleRepositoryPort | undefined
  requirePlatformRuleReviewer: (request: IncomingMessage) => ReviewerPrincipal
  supportedPlatforms: readonly string[]
  canonicalJson: (value: unknown) => string
}

function validIdentifier(value: string, name: string, max = 128): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${name} 格式无效`, 400)
  }
  return normalized
}

function decodeCursor(value: unknown): PublicRuleReviewCursor | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 512) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'cursor 格式无效', 400)
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))
      || typeof parsed.id !== 'string' || !parsed.id.trim() || parsed.id.length > 255) throw new Error('cursor')
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id }
  } catch {
    throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'cursor 格式无效', 400)
  }
}

function encodeCursor(cursor: PublicRuleReviewCursor | undefined) {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : undefined
}

function projectReviewRule(version: PersistedRuleVersion, canonicalJson: (value: unknown) => string, supportedPlatforms: readonly string[]) {
  const { __public_scope: marker, ...checks } = version.checks ?? {}
  const checksumValid = createHash('sha256').update(canonicalJson(checks)).digest('hex') === version.checksum
  const platform = version.scopeValue ?? version.targetId
  const platformBound = version.scope === 'platform' && Boolean(platform && supportedPlatforms.includes(platform))
  const manualProvenanceValid = platformBound && version.sourceKind === 'internal'
    && version.sourceReference.startsWith('manual://') && marker === 'platform' && Boolean(version.createdBy)
  const signedProvenanceValid = platformBound && version.sourceKind === 'official'
    && version.createdBy === 'signed-rule-sync' && !version.sourceReference.startsWith('manual://')
  // A trust label is an assertion about both origin and intact payload. Keep
  // malformed or legacy rows visibly unverified even if their lifecycle state
  // says active; activation/runtime gates independently enforce the same rule.
  const trust = checksumValid && manualProvenanceValid
    ? version.status === 'draft' ? 'manual_pending_review' : version.status === 'active' ? 'manual_reviewed' : 'manual_inactive'
    : checksumValid && signedProvenanceValid ? 'signed_import' : 'unverified'
  return {
    id: version.id,
    platform: version.scopeValue ?? version.targetId ?? undefined,
    pack_id: version.packId,
    name: version.name,
    version: version.version,
    scope: 'platform',
    category: marker === 'platform' ? 'platform' : version.category ?? undefined,
    status: version.status,
    source: { kind: version.sourceKind, reference: version.sourceReference, checked_at: new Date(version.sourceCheckedAt).toISOString(), trust },
    checks,
    checksum: version.checksum,
    checksum_valid: checksumValid,
    created_by: version.createdBy,
    created_at: new Date(version.createdAt).toISOString(),
    updated_at: new Date(version.updatedAt).toISOString(),
    revision: version.revision,
    severity: version.severity,
    action: version.action,
    ...(version.effectiveFrom ? { effective_from: new Date(version.effectiveFrom).toISOString() } : {}),
    ...(version.effectiveTo ? { effective_to: new Date(version.effectiveTo).toISOString() } : {}),
    ...(version.activatedAt ? { activated_at: new Date(version.activatedAt).toISOString() } : {}),
    ...(version.deactivatedAt ? { deactivated_at: new Date(version.deactivatedAt).toISOString() } : {}),
  }
}

function projectAudit(item: PersistedRuleAudit, platform: string) {
  return {
    id: item.id,
    platform,
    pack_id: item.rulePackId,
    version: item.version,
    action: item.action,
    actor_id: item.actorId,
    ...(item.reason ? { reason: item.reason } : {}),
    occurred_at: new Date(item.occurredAt).toISOString(),
    data: item.data,
  }
}

function requirePublicReviewRepository(req: IncomingMessage, dependencies: PublicRuleGovernanceDependencies) {
  const principal = dependencies.requirePlatformRuleReviewer(req)
  if (!principal.actorId || principal.workbench !== 'platform') throw new DomainError(ERROR_CODES.FORBIDDEN, '公共规则草稿仅允许平台规则审阅工作台读取', 403)
  const repository = dependencies.ruleRepository()
  if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '公共规则审阅需要持久化规则仓储', 503)
  return repository as RuleRepositoryPort & {
    listPublicDraftsForReview?: (input: { platform?: string; limit: number; cursor?: PublicRuleReviewCursor }) => Promise<{ items: PersistedRuleVersion[]; nextCursor?: PublicRuleReviewCursor }>
    getPublicRuleForReview?: (platform: string, packId: string, version: string) => Promise<PersistedRuleVersion | undefined>
    listPublicRuleAuditForReview?: (platform: string, packId: string, version: string) => Promise<PersistedRuleAudit[]>
  }
}

export async function handlePublicRuleDraftsList(
  req: IncomingMessage,
  params: JsonObject,
  dependencies: PublicRuleGovernanceDependencies,
) {
  // This check must inspect the authenticated principal, not a client supplied
  // workbench header. These rows are global platform control-plane data.
  const reviewRepository = requirePublicReviewRepository(req, dependencies)
  if (!reviewRepository.listPublicDraftsForReview) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '公共规则草稿列表仓储未配置', 503)
  const platform = typeof params.platform === 'string' && params.platform.trim() ? validIdentifier(params.platform, 'platform', 32) : undefined
  if (platform && !dependencies.supportedPlatforms.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
  const rawLimit = params.limit === undefined ? 50 : Number(params.limit)
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 100 的整数', 400)
  const page = await reviewRepository.listPublicDraftsForReview({ platform, limit: rawLimit, cursor: decodeCursor(params.cursor) })
  return dependencies.result({
    items: page.items.map(item => projectReviewRule(item, dependencies.canonicalJson, dependencies.supportedPlatforms)),
    ...(page.nextCursor ? { next_cursor: encodeCursor(page.nextCursor) } : {}),
  })
}

export async function handlePublicRuleDraftsGet(
  req: IncomingMessage,
  params: JsonObject,
  dependencies: PublicRuleGovernanceDependencies,
) {
  const reviewRepository = requirePublicReviewRepository(req, dependencies)
  if (!reviewRepository.getPublicRuleForReview || !reviewRepository.listPublicRuleAuditForReview) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '公共规则草稿详情仓储未配置', 503)
  const platform = validIdentifier(dependencies.required(params, 'platform'), 'platform', 32)
  if (!dependencies.supportedPlatforms.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
  const packId = validIdentifier(dependencies.required(params, 'pack_id'), 'pack_id')
  const versionName = validIdentifier(dependencies.required(params, 'version'), 'version')
  const rule = await reviewRepository.getPublicRuleForReview(platform, packId, versionName)
  if (!rule) throw new DomainError('RULE_VERSION_NOT_FOUND', '公共平台规则版本不存在', 404)
  const audit = await reviewRepository.listPublicRuleAuditForReview(platform, packId, versionName)
  return dependencies.result({
    rule: projectReviewRule(rule, dependencies.canonicalJson, dependencies.supportedPlatforms),
    audit: audit.map(item => projectAudit(item, platform)),
  })
}
