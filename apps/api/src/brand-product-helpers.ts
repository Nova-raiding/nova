import { DomainError, type MerchantService, type Product } from '../../../packages/application/src/service.js'
import type { BrandUnitRepository } from '../../../packages/persistence/src/index.js'
import type { CommercialCountBenefitCode } from './commercial-count-capacity.js'

type BrandProfile = NonNullable<ReturnType<MerchantService['getBrandProfile']>>

export function productFactsConfirmation(product: Pick<Product, 'id' | 'factsConfirmed'>) {
  const state: 'awaiting_confirmation' | 'confirmed' = product.factsConfirmed ? 'confirmed' : 'awaiting_confirmation'
  return {
    state,
    required: !product.factsConfirmed,
    product_id: product.id,
    next_action: product.factsConfirmed ? null : { method: 'catalog.facts.confirm', params: { product_id: product.id }, confirmation: 'interactive_confirmation' as const },
  }
}

export function batchFactsConfirmation(products: readonly Pick<Product, 'id' | 'factsConfirmed'>[]) {
  const pending = products.filter(product => !product.factsConfirmed).map(product => product.id)
  return {
    state: pending.length ? 'awaiting_confirmation' as const : 'confirmed' as const,
    required: pending.length > 0,
    product_ids: products.map(product => product.id),
    pending_product_ids: pending,
    next_actions: pending.map(productId => ({ method: 'catalog.facts.confirm', params: { product_id: productId }, confirmation: 'interactive_confirmation' as const })),
  }
}

export async function brandProfileWithUnit(
  workspaceId: string,
  profile: BrandProfile,
  dependencies: {
    ready: Promise<unknown>
    repository: () => BrandUnitRepository
    requireCommercialCountCapacity: (input: { workspaceId: string; code: CommercialCountBenefitCode; used: number; label: string }) => Promise<unknown>
  },
  ensure = true,
) {
  await dependencies.ready
  const repository = dependencies.repository()
  const selectedBrandUnitId = profile.brandUnitId?.trim() || profile.id
  let unit = (await repository.listBrands({ workspaceId, brandId: selectedBrandUnitId }))[0]
  if (!unit && ensure) {
    const existingBrands = await repository.listBrands({ workspaceId })
    await dependencies.requireCommercialCountCapacity({ workspaceId, code: 'max_brands', used: existingBrands.length + 1, label: '个品牌' })
    try {
      unit = await repository.createBrand({ workspaceId, id: profile.id, name: profile.name })
    } catch (error) {
      if (String(error).includes('BRAND_UNIT_CONFLICT') || (error as { code?: string })?.code === '23505') {
        unit = (await repository.listBrands({ workspaceId, brandId: profile.id }))[0]
      } else throw error
    }
  }
  if (!unit) {
    const candidates = await repository.listBrands({ workspaceId })
    return {
      ...profile,
      brandUnitId: null,
      brandUnit: null,
      brandUnitCandidates: candidates.map(candidate => ({ id: candidate.id, name: candidate.name, revision: candidate.revision, storeBindings: candidate.storeBindings })),
      brandUnitSelectionRequired: candidates.length > 0,
      brandUnitNextAction: candidates.length > 0 ? 'brand-unit.list' : 'brand.upsert',
    }
  }
  return { ...profile, brandUnitId: unit.id, brandUnit: unit }
}

type PersistSnapshot = (workspaceId: string, entityType: 'product' | 'task', entity: { id: string; version?: number; revision?: number }, value: Record<string, unknown>) => Promise<unknown>
type PersistEvent = (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>

export interface ProductFactsTransitionDependencies {
  service: MerchantService
  persistSnapshot: PersistSnapshot
  persistEvent: PersistEvent
}

export async function confirmProductFactsTransition(input: { workspaceId: string; productId: string; source: 'mcp' | 'rest' }, dependencies: ProductFactsTransitionDependencies) {
  const { service, persistSnapshot, persistEvent } = dependencies
  const current = service.products.get(input.productId)
  if (!current || current.workspaceId !== input.workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
  if (current.factsConfirmed) {
    const resumedTasks = service.refreshTasksAfterProductFacts(input.workspaceId, input.productId)
    for (const task of resumedTasks) {
      await persistSnapshot(input.workspaceId, 'task', task, task as unknown as Record<string, unknown>)
      await persistEvent(input.workspaceId, task.id, 'task.facts_unblocked', task.version, { task_id: task.id, product_id: current.id, state: task.state, source: input.source })
    }
    return { product: current, resumedTasks, changed: false }
  }
  const product = service.confirmProductFacts(input.workspaceId, input.productId)
  const resumedTasks = service.refreshTasksAfterProductFacts(input.workspaceId, input.productId)
  await persistSnapshot(input.workspaceId, 'product', product, product as unknown as Record<string, unknown>)
  await persistEvent(input.workspaceId, product.id, 'product.facts_confirmed', product.version ?? 1, { product_id: product.id, version: product.version ?? 1, source: input.source })
  for (const task of resumedTasks) {
    await persistSnapshot(input.workspaceId, 'task', task, task as unknown as Record<string, unknown>)
    await persistEvent(input.workspaceId, task.id, 'task.facts_unblocked', task.version, { task_id: task.id, product_id: product.id, state: task.state, source: input.source })
  }
  return { product, resumedTasks, changed: true }
}

export async function persistTaskAnswerFactConfirmation(input: { workspaceId: string; productId: string; factsConfirmedBefore: boolean; confirmationRequested: boolean }, dependencies: ProductFactsTransitionDependencies) {
  if (!input.confirmationRequested || input.factsConfirmedBefore) return
  const { service, persistSnapshot, persistEvent } = dependencies
  const product = service.products.get(input.productId)
  if (!product?.factsConfirmed) return
  await persistSnapshot(input.workspaceId, 'product', product, product as unknown as Record<string, unknown>)
  await persistEvent(input.workspaceId, product.id, 'product.facts_confirmed', product.version ?? 1, { product_id: product.id, version: product.version ?? 1, source: 'task.answer' })
  const resumedTasks = service.refreshTasksAfterProductFacts(input.workspaceId, product.id)
  for (const resumedTask of resumedTasks) {
    await persistSnapshot(input.workspaceId, 'task', resumedTask, resumedTask as unknown as Record<string, unknown>)
    await persistEvent(input.workspaceId, resumedTask.id, 'task.facts_unblocked', resumedTask.version, { task_id: resumedTask.id, product_id: product.id, state: resumedTask.state, source: 'task.answer' })
  }
}
