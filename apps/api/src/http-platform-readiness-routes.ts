import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MerchantService, Platform } from '../../../packages/application/src/service.js'
import type { ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'
import type { ApiEnvelope } from '../../../packages/contracts/src/index.js'
import type { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'
import type { MappingPreflightApprovalRepository } from '../../../packages/persistence/src/mapping-preflight-approval-repository.js'
import type { PlatformMediaSpecRepository, PlatformMediaSpecPlatform } from '../../../packages/persistence/src/platform-media-spec-repository.js'
import type { PlatformCapabilityEvidenceRow } from './platform-capability-response.js'

type Send = <T>(res: ServerResponse, status: number, workspaceId: string, data: T | null, error?: ApiEnvelope<T>['error'], req?: IncomingMessage) => void
type BundleVerification = { valid: boolean; content_publishable: boolean; manifest_hash: string; artifact_sha256: string }
type VisualAuthenticity = { publishable: true; candidateSha256: string; evaluatedAt: string; findingCodes: string[] }

export async function handleHttpPlatformReadinessRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: {
  service: MerchantService
  business?: Pick<PostgresBusinessRepository, 'listProductsPage'>
  connectorRuntime: ConnectorRuntime
  supportedPlatforms: readonly Platform[]
  mediaSpecRepository: () => Promise<Pick<PlatformMediaSpecRepository, 'list'>>
  mappingApprovalRepository: () => Promise<Pick<MappingPreflightApprovalRepository, 'get' | 'resolveActive'>>
  resolveWorkspace: (req: IncomingMessage, candidate?: unknown) => string
  accessibleProductIds: (req: IncomingMessage, workspaceId: string) => Promise<ReadonlySet<string> | undefined>
  filterByTaskBrandAccess: <T extends { brandId?: string }>(req: IncomingMessage, workspaceId: string, tasks: T[]) => Promise<T[]>
  projectPlatformCapabilityEvidence: (capabilities: ReturnType<ConnectorRuntime['capabilityMatrix']>, specs: Awaited<ReturnType<PlatformMediaSpecRepository['list']>>, platform: Platform) => PlatformCapabilityEvidenceRow[]
  asPlatform: (value: unknown) => PlatformMediaSpecPlatform | undefined
  verifyExportedBundle: (workspaceId: string, contentVersionId: string, binaryBody: Uint8Array) => BundleVerification
  send: Send
}) {
  if (req.method === 'GET' && path === '/v1/platform-capabilities') {
    const workspaceId = deps.resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    const generatedAt = new Date().toISOString()
    const mediaSpecRepository = await deps.mediaSpecRepository()
    const mediaSpecs = await mediaSpecRepository.list({ status: 'approved', device: 'desktop', at: generatedAt })
    return deps.send(res, 200, workspaceId, {
      items: deps.supportedPlatforms.map(platform => ({
        platform,
        readiness: deps.connectorRuntime.readiness[platform],
        capabilities: deps.projectPlatformCapabilityEvidence(deps.connectorRuntime.capabilityMatrix(platform), mediaSpecs, platform),
      })),
    }, null, req)
  }
  if (req.method === 'GET' && path === '/v1/delivery-readiness') {
    const workspaceId = deps.resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    const accessibleIds = await deps.accessibleProductIds(req, workspaceId)
    const products = (deps.business
      ? (await deps.business.listProductsPage(workspaceId, { limit: 100, offset: 0 })).items
      : deps.service.listProducts(workspaceId))
      .filter(product => typeof product.id === 'string' && (accessibleIds === undefined || accessibleIds.has(product.id)))
    const repository = await deps.mappingApprovalRepository()
    const generatedAt = new Date().toISOString()
    const mappingPreflights = await Promise.all(products.flatMap(product => {
      const productId = typeof product.id === 'string' ? product.id : undefined
      const platform = deps.asPlatform(product.platform)
      if (!productId || !platform) return []
      return [repository.get({ workspaceId, platform, productId }).then(async approval => {
        const active = approval ? await repository.resolveActive({ workspaceId, platform, productId, productVersion: typeof product.version === 'number' ? product.version : 1, mappedPayloadHash: approval.mappedPayloadHash, remoteSnapshotHash: approval.remoteSnapshotHash, schemaVersion: approval.schemaVersion, schemaEvidenceHash: approval.schemaEvidenceHash, mappingVersion: approval.mappingVersion, mappingEvidenceHash: approval.mappingEvidenceHash, at: generatedAt }) : undefined
        const approved = Boolean(active)
        const findingCodes = approval?.findingCodes ?? []
        const findings = findingCodes.map(code => ({ code, message: `字段映射预检 finding：${code}`, nextAction: '修正字段映射后重新执行 platform.mapping.preflight' }))
        if (!approval) findings.push({ code: 'MAPPING_PREFLIGHT_MISSING', message: '尚无持久化字段映射预检审批', nextAction: '执行 platform.mapping.preflight 并完成商家确认' })
        else if (!approved && findings.length === 0) findings.push({ code: 'MAPPING_PREFLIGHT_NOT_ACTIVE', message: '字段映射预检审批已过期、撤销或未满足发布条件', nextAction: '重新执行 platform.mapping.preflight' })
        return { id: `${platform}:${productId}`, platform, productId, status: approved ? 'passed' : approval ? 'blocked' : 'unverified', findings }
      })]
    }))
    const productIds = new Set(products.map(product => product.id))
    const visibleTasks = (await deps.filterByTaskBrandAccess(req, workspaceId, deps.service.listTasks(workspaceId))).filter(task => productIds.has(task.productId))
    const bundles = visibleTasks.flatMap(task => deps.service.listContentVersions(workspaceId, task.id)
      .filter(version => version.state === 'approved')
      .map(version => {
        try {
          const exported = deps.service.exportContent(workspaceId, version.id, 'bundle')
          if (!exported.binaryBody) throw new Error('bundle bytes missing')
          const verification = deps.verifyExportedBundle(workspaceId, version.id, exported.binaryBody)
          const passed = verification.valid === true && verification.content_publishable === true
          return { id: version.id, taskId: task.id, productId: task.productId, status: passed ? 'passed' : 'blocked', findings: passed ? [] : [{ code: 'DELIVERY_BUNDLE_NOT_VERIFIED', message: '交付包完整性或内容发布状态未通过', nextAction: '重新导出并执行 delivery.bundle.verify' }], verification: { valid: verification.valid, manifestHash: verification.manifest_hash, artifactSha256: verification.artifact_sha256 } }
        } catch {
          return { id: version.id, taskId: task.id, productId: task.productId, status: 'blocked', findings: [{ code: 'DELIVERY_BUNDLE_BUILD_FAILED', message: '无法从当前已批准版本生成并验证交付包', nextAction: '修复内容版本或导出配置后重试' }] }
        }
      }))
    const authenticity = [...deps.service.imageGenerationJobs.values()]
      .filter(job => job.workspaceId === workspaceId && productIds.has(job.productId) && job.state === 'succeeded' && job.archiveState === 'archived')
      .flatMap(job => (job.outputs ?? []).map(output => {
        const evidence = output.authenticity as unknown as VisualAuthenticity | undefined
        const passed = evidence?.publishable === true && evidence.candidateSha256 === output.sha256
        return { id: output.visualRef, jobId: job.id, productId: job.productId, status: passed ? 'passed' : evidence ? 'blocked' : 'unverified', findings: passed ? [] : [{ code: evidence ? 'VISUAL_AUTHENTICITY_BLOCKED' : 'VISUAL_AUTHENTICITY_MISSING', message: evidence ? '视觉真实性证据未满足发布要求' : '视觉候选尚无真实性证据', nextAction: '执行 catalog.image.review 并绑定当前候选 SHA-256' }] }
      }))
    const dimensionStatus = (items: Array<{ status: string }>) => !items.length ? 'unverified' : items.every(item => item.status === 'passed') ? 'passed' : 'blocked'
    const dimensions = { mapping: dimensionStatus(mappingPreflights), bundles: dimensionStatus(bundles), authenticity: dimensionStatus(authenticity) }
    const hashVerified = bundles.length > 0 && bundles.every(item => item.status === 'passed' && item.verification?.valid === true && /^[a-f0-9]{64}$/u.test(item.verification.manifestHash) && /^[a-f0-9]{64}$/u.test(item.verification.artifactSha256))
    const hashBlocked = bundles.some(item => item.verification?.valid === false || (item.status === 'blocked' && item.verification !== undefined))
    const gate = {
      authenticityGate: authenticity.length === 0
        ? { status: 'unverified', reason: 'API 未返回真实性 gate 结果' }
        : { status: dimensions.authenticity, reason: dimensions.authenticity === 'passed' ? '候选已绑定真实性 gate 结果' : '真实性 gate 未通过' },
      realRender: { status: 'unverified', reason: 'API 未返回真实渲染 artifact、renderer version 和校验哈希' },
      ocr: { status: 'unverified', reason: 'API 未返回原图与候选图 OCR 证据' },
      humanAttestation: { status: 'unverified', reason: 'API 未返回绑定候选哈希的人审 attestation' },
      bundleHash: hashVerified
        ? { status: 'passed', reason: 'Manifest hash 与 artifact SHA-256 已校验' }
        : { status: hashBlocked ? 'blocked' : 'unverified', reason: hashBlocked ? 'Bundle 哈希校验未通过或格式无效' : 'API 未返回 bundle 哈希校验' },
    }
    const gateValues = Object.values(gate).map(value => value.status)
    const gateStatus = gateValues.every(value => value === 'passed') ? 'passed' : gateValues.includes('blocked') ? 'blocked' : 'unverified'
    const status = gateStatus === 'passed' && Object.values(dimensions).every(value => value === 'passed') ? 'passed' : gateStatus === 'blocked' || Object.values(dimensions).includes('blocked') ? 'blocked' : 'unverified'
    return deps.send(res, 200, workspaceId, { generatedAt, status, dimensions, gate: { status: gateStatus, ...gate }, mappingPreflights, bundles, authenticity }, null, req)
  }
}
