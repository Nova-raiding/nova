import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Product, type Task } from '../../../packages/application/src/service.js'
import type { CanonicalProductReadMode } from '../../../packages/application/src/canonical-product-consistency.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>
type BriefResult = { id: string; version: number; assetType: string; platform: Platform; skuIds: string[] }
type PreviewResult = { id: string; assetType: string; platform: string }

export interface McpCreativeDependencies {
  service: MerchantService
  required: (params: JsonObject, name: string) => string
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  enforceProductBrandAccess: (req: IncomingMessage, workspaceId: string, productId: string) => Promise<void>
  canonicalProductReadControl: (workspaceId: string) => Promise<{ mode: CanonicalProductReadMode }>
  resolveCanonicalTaskScope: (input: { workspaceId: string; productId: string; platform: Platform; accountId?: string; requireCanonical?: boolean; requireListing?: boolean }) => Promise<unknown>
  creativeBrief: (workspaceId: string, product: Product, params: JsonObject) => BriefResult
  creativePreview: (workspaceId: string, product: Product, params: JsonObject) => PreviewResult
  enforceMcpCommercialAccess: (req: IncomingMessage, workspaceId: string, method: string) => Promise<unknown>
  observeLegacyWalletShadow: (workspaceId: string) => Promise<unknown>
  principalActorId: (req: IncomingMessage) => string | undefined
  header: (req: IncomingMessage, name: string) => string | undefined
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  refundPluginWalletDebit: (input: { workspaceId: string; debitIdempotencyKey: string; actorId: string; reason: string }) => Promise<unknown>
  persistSnapshot: (workspaceId: string, entityType: 'task', entity: Task, value: Record<string, unknown>) => Promise<void>
}

export async function handleMcpCreative(method: string, params: JsonObject, req: IncomingMessage, workspaceId: string, deps: McpCreativeDependencies): Promise<unknown> {
  const { service, required, scopeTask, enforceProductBrandAccess, canonicalProductReadControl, resolveCanonicalTaskScope, creativeBrief, creativePreview, enforceMcpCommercialAccess, observeLegacyWalletShadow, principalActorId, header, persistEvent, refundPluginWalletDebit, persistSnapshot } = deps
  switch (method) {
    case 'creative.directions': {
      const task = scopeTask(req, required(params, 'task_id'))
      return (service.listCreativeDirections(workspaceId, task.id))
    }
    case 'creative.brief': {
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      await enforceProductBrandAccess(req, workspaceId, productId)
      if ((await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '请先确认商品、SKU、价格和图片事实，再生成创意 Brief', 409)
      service.assertBrandVisualGenerationReady(workspaceId, product.platform)
      const brief = creativeBrief(workspaceId, product, params)
      await enforceMcpCommercialAccess(req, workspaceId, method)
      await observeLegacyWalletShadow(workspaceId)
      const briefDebitKey = `creative-brief:${brief.id}`
      const briefActor = principalActorId(req) ?? header(req, 'x-actor-id')?.trim() ?? 'merchant'
      await observeLegacyWalletShadow(workspaceId)
      try {
        await persistEvent(workspaceId, brief.id, 'creative.brief_created', brief.version, { brief_id: brief.id, product_id: product.id, asset_type: brief.assetType, platform: brief.platform, sku_ids: brief.skuIds })
      } catch (error) {
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: briefDebitKey, actorId: briefActor, reason: '创意 Brief 结果记录失败' })
        throw error
      }
      return (brief)
    }
    case 'creative.preview': {
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      await enforceProductBrandAccess(req, workspaceId, productId)
      if ((await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '请先确认商品事实，再生成创意预览', 409)
      service.assertBrandVisualGenerationReady(workspaceId, product.platform)
      const preview = creativePreview(workspaceId, product, params)
      await enforceMcpCommercialAccess(req, workspaceId, method)
      await observeLegacyWalletShadow(workspaceId)
      const previewDebitKey = `creative-preview:${preview.id}`
      const previewActor = principalActorId(req) ?? header(req, 'x-actor-id')?.trim() ?? 'merchant'
      await observeLegacyWalletShadow(workspaceId)
      try {
        await persistEvent(workspaceId, preview.id, 'creative.preview_created', 1, { preview_id: preview.id, product_id: product.id, asset_type: preview.assetType, platform: preview.platform })
      } catch (error) {
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: previewDebitKey, actorId: previewActor, reason: '创意预览结果记录失败' })
        throw error
      }
      return (preview)
    }
    case 'creative.directions.update': {
      const task = scopeTask(req, required(params, 'task_id'))
      let directionIds: string[] | undefined
      let changes: Record<string, string> | undefined
      try {
        if (typeof params.direction_ids_json === 'string') {
          const parsed = JSON.parse(params.direction_ids_json)
          if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('invalid direction ids')
          directionIds = parsed
        }
        if (typeof params.changes_json === 'string') {
          const parsed = JSON.parse(params.changes_json)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid changes')
          changes = parsed as Record<string, string>
        }
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, '方向参数 JSON 无效', 400) }
      const updated = service.updateCreativeDirections({ workspaceId, taskId: task.id, action: required(params, 'action') as 'regenerate' | 'merge' | 'modify', ...(directionIds ? { directionIds } : {}), ...(typeof params.direction_id === 'string' ? { directionId: params.direction_id } : {}), ...(changes ? { changes } : {}), ...(typeof params.feedback === 'string' ? { feedback: params.feedback } : {}), ...(typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? { expectedVersion: Number(params.expected_version) } : {}) })
      await persistSnapshot(workspaceId, 'task', updated.task, updated.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, updated.task.id, 'task.directions_updated', updated.task.version, { task_id: updated.task.id, action: params.action, direction_id: updated.newDirection?.id ?? null })
      return (updated)
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知创意 MCP 方法: ${method}`, 400)
  }
}
