import type { Product, Task } from './api.js'

/**
 * The ordering contract for the merchant-facing product picker.
 *
 * This is intentionally a pure helper: the current demo's Products JSX is
 * embedded in App.tsx, so the owner can wire this contract without moving
 * state or changing navigation in a concurrent edit.
 */
export function productIdentityKey(product: Pick<Product, 'id' | 'platform' | 'accountId' | 'remoteId'>): string {
  return [product.platform, product.accountId?.trim() ?? '', product.remoteId?.trim() || product.id].join(':')
}

function isFixtureProduct(product: Pick<Product, 'source' | 'storeName' | 'id'>): boolean {
  const value = `${product.source} ${product.storeName} ${product.id}`.toLowerCase()
  return /fixture|演示|demo|mock/.test(value)
}

function hasUsableStoreIdentity(product: Pick<Product, 'accountId' | 'storeName'>): boolean {
  return Boolean(product.accountId?.trim() && product.storeName.trim())
}

/**
 * Keep one row per platform/store/listing identity and put safe, real rows
 * before fixture rows. A fixture is never allowed to outrank a usable real
 * product merely because it was returned first by the API.
 */
export function prioritizeProducts(products: Product[]): Product[] {
  const unique = new Map<string, Product>()
  for (const product of products) {
    const key = productIdentityKey(product)
    const previous = unique.get(key)
    if (!previous || productScore(product) > productScore(previous)) unique.set(key, product)
  }
  return [...unique.values()].sort((left, right) => productScore(right) - productScore(left))
}

/** Real API rows may only proceed when the server has verified their canonical chain. */
export function canonicalProductActionAllowed(input: { apiConfigured: boolean; status?: string }): boolean {
  return !input.apiConfigured || input.status === 'verified'
}

function productScore(product: Product): number {
  let score = 0
  if (hasUsableStoreIdentity(product)) score += 100
  if (!isFixtureProduct(product)) score += 50
  if (product.factsConfirmed) score += 10
  if (product.sourceAssetIds?.length) score += 5
  return score
}

export type TaskRecoveryGroup = 'needs-attention' | 'ready-to-continue' | 'completed'

export type TaskRecoveryItem = {
  task: Task
  group: TaskRecoveryGroup
  groupLabel: string
  actionLabel: string
}

const completedStates = new Set(['approved', 'publish_prepared', 'publishing', 'delivered'])
const attentionStates = new Set(['failed_recoverable', 'failed_terminal'])

export function taskRecoveryGroup(task: Pick<Task, 'state' | 'missingQuestions'>): TaskRecoveryGroup {
  if (completedStates.has(task.state)) return 'completed'
  if (attentionStates.has(task.state) || Boolean(task.missingQuestions?.length)) return 'needs-attention'
  return 'ready-to-continue'
}

/** Stable grouping order matches the traditional merchant's priority: fix blockers, continue work, then review history. */
export function groupTasksForRecovery(tasks: Task[]): TaskRecoveryItem[] {
  const labels: Record<TaskRecoveryGroup, string> = {
    'needs-attention': '需要我处理',
    'ready-to-continue': '可以继续',
    completed: '已完成',
  }
  const actions: Record<TaskRecoveryGroup, string> = {
    'needs-attention': '恢复任务',
    'ready-to-continue': '恢复任务',
    completed: '恢复任务',
  }
  const order: Record<TaskRecoveryGroup, number> = { 'needs-attention': 0, 'ready-to-continue': 1, completed: 2 }
  return tasks
    .map(task => {
      const group = taskRecoveryGroup(task)
      return { task, group, groupLabel: labels[group], actionLabel: actions[group] }
    })
    .sort((left, right) => order[left.group] - order[right.group] || right.task.createdAt.localeCompare(left.task.createdAt))
}
