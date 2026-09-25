import { DomainError } from '../../../packages/application/src/service.js'
import {
  PlatformMediaSpecRepositoryError,
  type PlatformMediaSpecDevice,
  type PlatformMediaSpecPlatform,
  type PlatformMediaSpecRepository,
  type PlatformMediaSpecStatus,
  type StoredPlatformMediaSpec,
} from '../../../packages/persistence/src/platform-media-spec-repository.js'

export const MCP_PLATFORM_MEDIA_SPEC_METHODS = new Set([
  'platform.media.spec.list',
  'platform.media.spec.get',
  'platform.media.spec.create',
  'platform.media.spec.update',
  'platform.media.spec.approve',
  'platform.media.spec.expire',
])

type Params = Record<string, unknown>
type Dependencies = {
  repository: () => Promise<PlatformMediaSpecRepository>
  requirePlatformOps: () => string
  required: (params: Params, key: string) => string
  requiredPositiveInteger: (params: Params, key: string, allowZero?: boolean) => number
  parseObject: (params: Params, key: string) => Record<string, unknown>
  asPlatform: (value: unknown) => PlatformMediaSpecPlatform | undefined
  asDevice: (value: unknown) => PlatformMediaSpecDevice | undefined
  asStatus: (value: unknown) => PlatformMediaSpecStatus | undefined
  isPlatformOperations: () => boolean
}

function mapRepositoryError(error: unknown): never {
  if (!(error instanceof PlatformMediaSpecRepositoryError)) throw error
  const mapped: Record<string, { status: number; message: string }> = {
    PLATFORM_MEDIA_SPEC_PLATFORM_OPS_REQUIRED: { status: 403, message: '平台媒体规格管理仅允许 platform_ops 角色' },
    PLATFORM_MEDIA_SPEC_INVALID: { status: 400, message: '平台媒体规格参数或证据无效' },
    PLATFORM_MEDIA_SPEC_NOT_FOUND: { status: 404, message: '平台媒体规格不存在' },
    PLATFORM_MEDIA_SPEC_APPROVAL_EVIDENCE_REQUIRED: { status: 409, message: '缺少可验证且未过期的批准证据' },
    PLATFORM_MEDIA_SPEC_REVISION_CONFLICT: { status: 409, message: '平台媒体规格版本已变化，请刷新后重试' },
    PLATFORM_MEDIA_SPEC_TRANSITION_INVALID: { status: 409, message: '平台媒体规格当前状态不允许该操作' },
    PLATFORM_MEDIA_SPEC_ACTIVE_CONFLICT: { status: 409, message: '同平台、版位和设备已有 active 规格' },
    PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT: { status: 409, message: '幂等键已绑定其他媒体规格操作' },
  }
  const value = mapped[error.code] ?? { status: 500, message: '平台媒体规格仓储失败' }
  throw new DomainError(error.code, value.message, value.status)
}

function isActive(spec: StoredPlatformMediaSpec, at = new Date().toISOString()) {
  return spec.status === 'approved' && Boolean(spec.expiresAt) && Date.parse(spec.expiresAt!) > Date.parse(at)
}

export async function handlePlatformMediaSpecMethod(method: string, params: Params, deps: Dependencies): Promise<unknown> {
  switch (method) {
    case 'platform.media.spec.list': {
      const repository = await deps.repository()
      const ops = deps.isPlatformOperations()
      const platform = params.platform === undefined ? undefined : deps.asPlatform(params.platform)
      const device = params.device === undefined ? undefined : deps.asDevice(params.device)
      const requestedStatus = params.status === undefined ? undefined : deps.asStatus(params.status)
      if (params.platform !== undefined && !platform || params.device !== undefined && !device || params.status !== undefined && !requestedStatus) throw new DomainError('INVALID_REQUEST', '媒体规格筛选参数无效', 400)
      try {
        const specs = await repository.list({ ...(platform ? { platform } : {}), ...(typeof params.placement === 'string' && params.placement.trim() ? { placement: params.placement.trim() } : {}), ...(device ? { device } : {}), ...(ops && requestedStatus ? { status: requestedStatus } : { status: 'approved' }), ...(ops && typeof params.at === 'string' ? { at: params.at } : {}) })
        const visible = ops ? specs : specs.filter(spec => isActive(spec))
        return { specs: visible, count: visible.length, visibility: ops ? 'all_authorized_states' : 'active_only' }
      } catch (error) { mapRepositoryError(error) }
    }
    case 'platform.media.spec.get': {
      const repository = await deps.repository()
      const ops = deps.isPlatformOperations()
      try {
        const spec = await repository.get(deps.required(params, 'id'), ops && typeof params.at === 'string' ? params.at : undefined)
        if (!spec || !ops && !isActive(spec)) throw new DomainError('PLATFORM_MEDIA_SPEC_NOT_FOUND', '平台媒体规格不存在或当前没有 active 证据', 404)
        return { spec, ...(ops ? { audit: await repository.listAudit(spec.id) } : {}), visibility: ops ? 'operator' : 'active_only' }
      } catch (error) { mapRepositoryError(error) }
    }
    case 'platform.media.spec.create': {
      const actorId = deps.requirePlatformOps()
      const repository = await deps.repository()
      const platform = deps.asPlatform(params.platform)
      const device = deps.asDevice(params.device)
      if (!platform || !device || deps.requiredPositiveInteger(params, 'expected_revision', true) !== 0) throw new DomainError('INVALID_REQUEST', '创建媒体规格的平台、设备或 expected_revision 无效', 400)
      try {
        const created = await repository.createDraft({ actorId, actorRole: 'merchant_ops', ...(typeof params.id === 'string' && params.id.trim() ? { id: params.id.trim() } : {}), platform, placement: deps.required(params, 'placement'), device, version: deps.required(params, 'version'), specJson: deps.parseObject(params, 'spec_json'), sourceUrl: deps.required(params, 'source_url'), sourceSha256: deps.required(params, 'source_sha256'), checkedAt: deps.required(params, 'checked_at'), ...(typeof params.evidence_artifact_ref === 'string' && params.evidence_artifact_ref.trim() ? { evidenceArtifactRef: params.evidence_artifact_ref.trim() } : {}), ...(typeof params.evidence_artifact_sha256 === 'string' && params.evidence_artifact_sha256.trim() ? { evidenceArtifactSha256: params.evidence_artifact_sha256.trim() } : {}), ...(typeof params.expires_at === 'string' && params.expires_at.trim() ? { expiresAt: params.expires_at.trim() } : {}), reason: deps.required(params, 'reason'), idempotencyKey: deps.required(params, 'idempotency_key') })
        return { ...created, audit: await repository.listAudit(created.spec.id) }
      } catch (error) { mapRepositoryError(error) }
    }
    case 'platform.media.spec.update': {
      const actorId = deps.requirePlatformOps()
      const repository = await deps.repository()
      const raw = deps.parseObject(params, 'patch_json')
      const allowed = new Set(['placement', 'device', 'version', 'spec_json', 'source_url', 'source_sha256', 'checked_at', 'evidence_artifact_ref', 'evidence_artifact_sha256', 'expires_at'])
      if (!Object.keys(raw).length || Object.keys(raw).some(key => !allowed.has(key))) throw new DomainError('INVALID_REQUEST', 'patch_json 包含不允许修改的字段', 400)
      const patch: Record<string, unknown> = {}
      if (raw.placement !== undefined) patch.placement = raw.placement
      if (raw.device !== undefined) patch.device = raw.device
      if (raw.version !== undefined) patch.version = raw.version
      if (raw.spec_json !== undefined) patch.specJson = raw.spec_json
      if (raw.source_url !== undefined) patch.sourceUrl = raw.source_url
      if (raw.source_sha256 !== undefined) patch.sourceSha256 = raw.source_sha256
      if (raw.checked_at !== undefined) patch.checkedAt = raw.checked_at
      if (raw.evidence_artifact_ref !== undefined) patch.evidenceArtifactRef = raw.evidence_artifact_ref
      if (raw.evidence_artifact_sha256 !== undefined) patch.evidenceArtifactSha256 = raw.evidence_artifact_sha256
      if (raw.expires_at !== undefined) patch.expiresAt = raw.expires_at
      try {
        const updated = await repository.updateDraft({ actorId, actorRole: 'merchant_ops', id: deps.required(params, 'id'), expectedRevision: deps.requiredPositiveInteger(params, 'expected_revision'), patch: patch as Parameters<PlatformMediaSpecRepository['updateDraft']>[0]['patch'], reason: deps.required(params, 'reason'), idempotencyKey: deps.required(params, 'idempotency_key') })
        return { ...updated, audit: await repository.listAudit(updated.spec.id) }
      } catch (error) { mapRepositoryError(error) }
    }
    case 'platform.media.spec.approve':
    case 'platform.media.spec.expire': {
      const actorId = deps.requirePlatformOps()
      const repository = await deps.repository()
      try {
        const input = { actorId, actorRole: 'merchant_ops' as const, id: deps.required(params, 'id'), expectedRevision: deps.requiredPositiveInteger(params, 'expected_revision'), reason: deps.required(params, 'reason'), idempotencyKey: deps.required(params, 'idempotency_key') }
        const changed = method === 'platform.media.spec.approve' ? await repository.approve(input) : await repository.expire(input)
        return { ...changed, audit: await repository.listAudit(changed.spec.id) }
      } catch (error) { mapRepositoryError(error) }
    }
  }
  throw new DomainError('MCP_METHOD_NOT_FOUND', `不支持的平台媒体规格方法: ${method}`, 404)
}
