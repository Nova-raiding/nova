import type { IncomingMessage } from 'node:http'
import { DomainError, type AssetMetadata } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { CustomerDeliveryRepository } from '../../../packages/persistence/src/customer-delivery-repository.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'
import { requiredStringValue } from './ops-params.js'
import { customerDeliveryUploadPurpose, customerDeliveryUploadView, validateCustomerDeliveryUpload, type CustomerDeliveryUploadPurpose } from './customer-delivery-upload.js'
import { downloadCustomerDeliveryContract } from './customer-delivery-contract-download.js'
import { validateCustomerDeliveryProfileValues } from './customer-delivery-profile-validation.js'
import { validateCustomerDeliveryJsonNoNul } from './customer-delivery-profile-validation.js'

type JsonObject = Record<string, unknown>
type DeliveryUpdate = Parameters<CustomerDeliveryRepository['update']>[0]

export const CUSTOMER_DELIVERY_MCP_METHODS = new Set([
  'ops.customer-delivery.accounts.list', 'ops.customer-delivery.account.bind', 'ops.customer-delivery.list',
  'ops.customer-delivery.assets.upload', 'ops.customer-delivery.assets.get', 'ops.customer-delivery.get',
  'ops.customer-delivery.create', 'ops.customer-delivery.update', 'ops.customer-delivery.checklist.update',
  'ops.customer-delivery.checklist-items.list', 'ops.customer-delivery.checklist-item.update',
  'ops.customer-delivery.training.complete', 'ops.customer-delivery.videos.list', 'ops.customer-delivery.videos.add',
])

export interface CustomerDeliveryMcpDependencies {
  repository: CustomerDeliveryRepository
  persistenceReady: Promise<unknown>
  businessPresent: () => boolean
  result: (value: unknown) => unknown
  requestActor: (request: IncomingMessage) => string
  invokeCustomerDeliveryDomain: <T>(operation: () => Promise<T>) => Promise<T>
  requiresStrictAuth: () => boolean
  revalidateDownloadedAuthorization: (request: IncomingMessage, workspaceId: string, params: JsonObject) => Promise<void>
  hydrateWorkspaceFromPersistence: (workspaceId: string) => Promise<unknown>
  uploadAssetForMcp: (workspaceId: string, params: JsonObject, request: IncomingMessage, batchIndex: undefined, securityPreflighted: false, deliveryContext: { deliveryId: string; purpose: CustomerDeliveryUploadPurpose }) => Promise<AssetMetadata>
  loadAsset: (workspaceId: string, assetRef: string) => Promise<Partial<AssetMetadata> | undefined>
  demoUnscannedAssetsEnabled: () => boolean
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
  assertCustomerDeliveryAssetBound: (workspaceId: string, deliveryId: string, purpose: CustomerDeliveryUploadPurpose, assetRef: string) => Promise<void>
  requireBoundCustomerDeliveryAsset: (workspaceId: string, deliveryId: string, purpose: CustomerDeliveryUploadPurpose, assetRef: string) => Promise<void>
  evidenceRefs: (value: unknown, label: string) => string[]
  updateCustomerDeliveryWithRequiredEvidence: (input: DeliveryUpdate) => Promise<Awaited<ReturnType<CustomerDeliveryRepository['update']>>>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function handleCustomerDeliveryMcpMethod(method: string, req: IncomingMessage, workspaceId: string, params: JsonObject, dependencies: CustomerDeliveryMcpDependencies) {
  const { repository, persistenceReady, businessPresent, result, requestActor, invokeCustomerDeliveryDomain, requiresStrictAuth, revalidateDownloadedAuthorization, hydrateWorkspaceFromPersistence, uploadAssetForMcp, loadAsset, demoUnscannedAssetsEnabled, recordOperationAudit, assertCustomerDeliveryAssetBound, requireBoundCustomerDeliveryAsset, evidenceRefs, updateCustomerDeliveryWithRequiredEvidence } = dependencies
  switch (method) {
    case 'ops.customer-delivery.accounts.list':
      return result(await invokeCustomerDeliveryDomain(() => repository.listBindableAccounts({ workspaceId, ...(typeof params.search === 'string' ? { search: params.search } : {}), ...(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}), ...(params.limit !== undefined ? { limit: Number(params.limit) } : {}) })))
    case 'ops.customer-delivery.account.bind':
      return result(await invokeCustomerDeliveryDomain(() => repository.bindAccount({ workspaceId, deliveryId: requiredStringValue(params, 'delivery_id'), targetAccountId: requiredStringValue(params, 'target_account_id'), expectedRevision: Number(requiredStringValue(params, 'expected_revision')), reason: requiredStringValue(params, 'reason'), actorId: requestActor(req) })))
    case 'ops.customer-delivery.list': {
      const page = await invokeCustomerDeliveryDomain(() => repository.list({
        workspaceId,
        ...(typeof params.query === 'string' ? { query: params.query } : {}),
        ...(typeof params.project_owner === 'string' ? { projectOwner: params.project_owner } : {}),
        ...(typeof params.support_owner === 'string' ? { supportOwner: params.support_owner } : {}),
        ...(params.offset !== undefined ? { offset: Number(params.offset) } : {}),
        ...(params.limit !== undefined ? { limit: Number(params.limit) } : {}),
      }))
      const options = await invokeCustomerDeliveryDomain(() => repository.listOwnerOptions(workspaceId))
      return result({ ...page,
        project_owner_options: options.projectOwnerOptions,
        support_owner_options: options.supportOwnerOptions,
      })
    }
    case 'ops.customer-delivery.assets.upload': {
      await persistenceReady
      const deliveryId = requiredStringValue(params, 'deliveryId', 'delivery_id')
      const delivery = await invokeCustomerDeliveryDomain(() => repository.get(workspaceId, deliveryId))
      if (!delivery) throw new DomainError('CUSTOMER_DELIVERY_NOT_FOUND', '客户交付档案不存在', 404)
      // Schema + exact workspace/RBAC + delivery existence precede outbound I/O.
      // Only downloaded bytes enter the existing quarantine/scan admission path;
      // a URL is never a contract reference or a trusted scan result.
      let fileParams = params
      if (params.source_url !== undefined) {
        if (params.purpose !== 'contract' || ['name', 'mime_type', 'content_base64', 'sha256'].some(key => key in params)) {
          throw new DomainError(ERROR_CODES.INVALID_REQUEST, '合同链接不能与本地文件字段同时提供', 400)
        }
        const controller = new AbortController()
        const abort = () => controller.abort()
        req.once('aborted', abort)
        req.socket.once('close', abort)
        try {
          if (req.socket.destroyed || req.aborted) controller.abort()
          const downloaded = await downloadCustomerDeliveryContract(requiredStringValue(params, 'source_url'), { signal: controller.signal })
          controller.signal.throwIfAborted()
          // Download can take tens of seconds. Recheck the durable identity and
          // platform capability before creating any asset or scan admission.
          // Do not replay the gateway's one-time OIDC nonce.
          if (requiresStrictAuth()) {
            await revalidateDownloadedAuthorization(req, workspaceId, params)
            controller.signal.throwIfAborted()
          }
          const { source_url: _sourceUrl, ...scopeParams } = params
          fileParams = { ...scopeParams, ...downloaded }
        } finally {
          req.removeListener('aborted', abort)
          req.socket.removeListener('close', abort)
        }
      }
      const validated = validateCustomerDeliveryUpload(fileParams)
      if (businessPresent()) await hydrateWorkspaceFromPersistence(workspaceId)
      const asset = await uploadAssetForMcp(workspaceId, {
        name: requiredStringValue(fileParams, 'name'), mime_type: validated.mimeType,
        content_base64: requiredStringValue(fileParams, 'content_base64'), sha256: validated.sha256,
        rights_scope: 'internal_only', usage_scopes_json: JSON.stringify([`customer_delivery_${validated.purpose}`]),
      }, req, undefined, false, { deliveryId, purpose: validated.purpose })
      const view = customerDeliveryUploadView(asset, validated.purpose, demoUnscannedAssetsEnabled())
      await recordOperationAudit({ workspaceId, actorId: requestActor(req), action: 'customer_delivery.asset.upload', resourceType: 'customer_delivery', resourceId: deliveryId, before: {}, after: { asset_ref: view.assetRef, purpose: validated.purpose, sha256: validated.sha256, size_bytes: view.sizeBytes, scan_status: view.scanStatus, source_kind: params.source_url === undefined ? 'file' : 'https_download' }, reason: '上传客户交付文件到隔离区，扫描通过后才可登记使用' })
      return result(view)
    }
    case 'ops.customer-delivery.assets.get': {
      await persistenceReady
      const deliveryId = requiredStringValue(params, 'deliveryId', 'delivery_id')
      const delivery = await invokeCustomerDeliveryDomain(() => repository.get(workspaceId, deliveryId))
      if (!delivery) throw new DomainError('CUSTOMER_DELIVERY_NOT_FOUND', '客户交付档案不存在', 404)
      const assetRef = requiredStringValue(params, 'assetRef', 'asset_ref')
      const purpose = customerDeliveryUploadPurpose(params.purpose)
      await assertCustomerDeliveryAssetBound(workspaceId, deliveryId, purpose, assetRef)
      const asset = await loadAsset(workspaceId, assetRef)
      return result(customerDeliveryUploadView(asset, purpose, demoUnscannedAssetsEnabled()))
    }
    case 'ops.customer-delivery.get': {
      const deliveryId = requiredStringValue(params, 'deliveryId', 'delivery_id')
      const delivery = await invokeCustomerDeliveryDomain(() => repository.get(workspaceId, deliveryId))
      if (!delivery) throw new DomainError('CUSTOMER_DELIVERY_NOT_FOUND', 'customer delivery not found', 404)
      return result(delivery)
    }
    case 'ops.customer-delivery.create': {
      const companyName = requiredStringValue(params, 'companyName', 'company_name')
      validateCustomerDeliveryProfileValues({ companyName })
      return result(await invokeCustomerDeliveryDomain(() => repository.create({ workspaceId, companyName, actorId: requestActor(req) })))
    }
    case 'ops.customer-delivery.update': {
      const rawPatch = requiredStringValue(params, 'patchJson', 'patch_json')
      let parsed: unknown
      try { parsed = JSON.parse(rawPatch) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'patch_json 必须是有效 JSON 对象', 400) }
      if (!isObject(parsed)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'patch_json 必须是 JSON 对象', 400)
      const allowed = new Set(['companyName', 'contractNumber', 'paymentStatus', 'contractRef', 'projectOwner', 'supportOwner', 'paymentDate', 'paymentEvidenceRefs', 'plannedGoLiveAt', 'customerProfileStatus', 'archivedAt'])
      if (Object.keys(parsed).some(key => !allowed.has(key))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'patch_json 包含不支持的字段', 400)
      validateCustomerDeliveryProfileValues(parsed)
      return result(await updateCustomerDeliveryWithRequiredEvidence({ workspaceId, id: requiredStringValue(params, 'deliveryId', 'delivery_id'), actorId: requestActor(req), expectedRevision: Number(requiredStringValue(params, 'expectedRevision', 'expected_revision')), patch: parsed }))
    }
    case 'ops.customer-delivery.checklist.update': {
      const checklistKey = requiredStringValue(params, 'checklistKey', 'checklist_key')
      if (!['customer_profile', 'system_integration', 'functional_acceptance'].includes(checklistKey)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'checklist_key 无效', 400)
      // The contract declares items_json only; the camelCase alias was a dead
      // branch the validator always rejected.
      const rawItems = params.items_json
      if (rawItems !== undefined && params.completed !== undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'completed 与 items_json 不能同时提供', 400)
      if (rawItems !== undefined) {
        if (checklistKey === 'customer_profile' || !repository.updateChecklistItems) throw new DomainError('CUSTOMER_DELIVERY_NOT_IMPLEMENTED', '该客户交付清单暂不支持批量逐项写入', 501)
        let parsed: unknown
        try { parsed = JSON.parse(String(rawItems)) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'items_json 必须是有效 JSON 数组', 400) }
        if (!Array.isArray(parsed)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'items_json 必须是 JSON 数组', 400)
        validateCustomerDeliveryJsonNoNul(parsed, 'items_json')
        const items = parsed.map((item, index) => {
          if (!isObject(item) || typeof item.itemKey !== 'string' || typeof item.completed !== 'boolean' && item.completed !== 'true' && item.completed !== 'false') throw new DomainError(ERROR_CODES.INVALID_REQUEST, `items_json 第 ${index + 1} 项格式无效`, 400)
          let evidence: Record<string, unknown> = {}
          if (item.evidence !== undefined) {
            if (typeof item.evidence === 'string') evidence = item.evidence.trim() ? { note: item.evidence.trim() } : {}
            else if (isObject(item.evidence)) evidence = item.evidence
            else throw new DomainError(ERROR_CODES.INVALID_REQUEST, `items_json 第 ${index + 1} 项 evidence 格式无效`, 400)
          }
          return { itemKey: item.itemKey, completed: item.completed === true || item.completed === 'true', evidence }
        })
        const deliveryId = requiredStringValue(params, 'deliveryId', 'delivery_id')
        const purpose = checklistKey as 'system_integration' | 'functional_acceptance'
        for (const [index, item] of items.entries()) {
          if (!item.completed) continue
          const refs = evidenceRefs(item.evidence.asset_refs, `items_json 第 ${index + 1} 项 asset_refs`)
          await Promise.all(refs.map(ref => requireBoundCustomerDeliveryAsset(workspaceId, deliveryId, purpose, ref)))
        }
        return result(await invokeCustomerDeliveryDomain(() => repository.updateChecklistItems!({ workspaceId, deliveryId, checklistKey: purpose, items, actorId: requestActor(req), expectedRevision: Number(requiredStringValue(params, 'expectedRevision', 'expected_revision')) })))
      }
      if (checklistKey !== 'customer_profile') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '系统接入和功能验收必须逐项更新，不能直接修改汇总状态', 400)
      if (params.completed === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'completed 或 items_json 至少提供一个', 400)
      if (![true, false, 'true', 'false'].includes(params.completed as boolean | string)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'completed 必须是布尔值', 400)
      const status: 'complete' | 'incomplete' = params.completed === true || params.completed === 'true' ? 'complete' : 'incomplete'
      const patch = { customerProfileStatus: status }
      return result(await updateCustomerDeliveryWithRequiredEvidence({ workspaceId, id: requiredStringValue(params, 'deliveryId', 'delivery_id'), actorId: requestActor(req), expectedRevision: Number(requiredStringValue(params, 'expectedRevision', 'expected_revision')), patch }))
    }
    case 'ops.customer-delivery.checklist-items.list': {
      if (!repository.listChecklistItems) throw new DomainError('CUSTOMER_DELIVERY_NOT_IMPLEMENTED', '客户交付清单项读取未实现', 501)
      const checklistKey = requiredStringValue(params, 'checklistKey', 'checklist_key')
      if (!['system_integration', 'functional_acceptance'].includes(checklistKey)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'checklist_key 无效', 400)
      return result({ items: await invokeCustomerDeliveryDomain(() => repository.listChecklistItems!({ workspaceId, deliveryId: requiredStringValue(params, 'deliveryId', 'delivery_id'), checklistKey: checklistKey as 'system_integration'|'functional_acceptance' })) })
    }
    case 'ops.customer-delivery.checklist-item.update': {
      if (!repository.updateChecklistItem) throw new DomainError('CUSTOMER_DELIVERY_NOT_IMPLEMENTED', '客户交付清单项写入未实现', 501)
      if (params.completed === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'completed 必须提供', 400)
      if (![true, false, 'true', 'false'].includes(params.completed as boolean | string)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'completed 必须是布尔值', 400)
      let evidence: Record<string, unknown> = {}
      if (params.evidence_json) { try { const parsed = JSON.parse(String(params.evidence_json)); if (!isObject(parsed)) throw new Error(); evidence = parsed } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'evidence_json 必须是有效 JSON 对象', 400) } }
      validateCustomerDeliveryJsonNoNul(evidence, 'evidence_json')
      const completed = params.completed === true || params.completed === 'true'
      const deliveryId = requiredStringValue(params, 'deliveryId', 'delivery_id')
      const checklistKey = requiredStringValue(params, 'checklistKey', 'checklist_key') as 'system_integration'|'functional_acceptance'
      if (completed) {
        const refs = evidenceRefs(evidence.asset_refs, 'asset_refs')
        await Promise.all(refs.map(ref => requireBoundCustomerDeliveryAsset(workspaceId, deliveryId, checklistKey, ref)))
      }
      return result(await invokeCustomerDeliveryDomain(() => repository.updateChecklistItem!({ workspaceId, deliveryId, checklistKey, itemKey: requiredStringValue(params, 'itemKey', 'item_key'), completed, evidence, actorId: requestActor(req), expectedRevision: Number(requiredStringValue(params, 'expectedRevision', 'expected_revision')) })))
    }
    case 'ops.customer-delivery.training.complete': {
      let rawRefs: unknown
      try { rawRefs = JSON.parse(requiredStringValue(params, 'evidenceRefsJson', 'evidence_refs_json')) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'evidence_refs_json 必须是有效 JSON 数组', 400) }
      const refs = evidenceRefs(rawRefs, '培训凭证')
      const completed = params.completed === true || params.completed === 'true'
      return result(await updateCustomerDeliveryWithRequiredEvidence({ workspaceId, id: requiredStringValue(params, 'deliveryId', 'delivery_id'), actorId: requestActor(req), expectedRevision: Number(requiredStringValue(params, 'expectedRevision', 'expected_revision')), patch: { trainingCompleted: completed, trainingEvidenceRefs: refs } }))
    }
    case 'ops.customer-delivery.videos.list': {
      const delivery = await invokeCustomerDeliveryDomain(() => repository.get(workspaceId, requiredStringValue(params, 'deliveryId', 'delivery_id')))
      if (!delivery) throw new DomainError('CUSTOMER_DELIVERY_NOT_FOUND', 'customer delivery not found', 404)
      return result({ items: delivery.videos })
    }
    case 'ops.customer-delivery.videos.add': {
      const assetRef = requiredStringValue(params, 'assetRef', 'asset_ref')
      await persistenceReady
      const deliveryId = requiredStringValue(params, 'deliveryId', 'delivery_id')
      await requireBoundCustomerDeliveryAsset(workspaceId, deliveryId, 'video', assetRef)
      return result(await invokeCustomerDeliveryDomain(() => repository.addVideo({ workspaceId, deliveryId, actorId: requestActor(req), title: requiredStringValue(params, 'title'), assetRef, ...(params.sort_order !== undefined ? { sortOrder: Number(params.sort_order) } : {}) })))
    }
    default: throw new DomainError(ERROR_CODES.MCP_METHOD_NOT_FOUND, `不支持的 MCP 方法: ${method}`, 404)
  }
}
