import { merchantEntryPointFromQuery, type MerchantEntryPoint } from './entry-points.js'

export const merchantPages = ['overview', 'products', 'task', 'publish', 'rules'] as const
export type MerchantPage = (typeof merchantPages)[number]
export type MerchantPlatformId = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'

export type MerchantRouteTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'product'; productId: string; platform?: MerchantPlatformId; accountId?: string; intentKey?: string }

export interface MerchantRoute {
  page: MerchantPage
  target?: MerchantRouteTarget
  searchQuery: string
  entry?: MerchantEntryPoint
}

type AnimationFrameScheduler = (callback: FrameRequestCallback) => number

export function focusMainAfterMerchantNavigation(
  main: Pick<HTMLElement, 'focus'> | null,
  scheduleFrame: AnimationFrameScheduler,
  focusBlocked: () => boolean,
): void {
  scheduleFrame(() => {
    scheduleFrame(() => {
      if (!focusBlocked()) main?.focus({ preventScroll: true })
    })
  })
}

const platforms = new Set<MerchantPlatformId>(['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'])
const merchantRoutePattern = /\/merchant\/(?:overview|products|tasks(?:\/new|\/[^/?#]+)?|publish|rules)\/?$/u

function platformFromQuery(value: string | null): MerchantPlatformId | undefined {
  return value && platforms.has(value as MerchantPlatformId) ? value as MerchantPlatformId : undefined
}

function legacyPage(hash: string): MerchantPage | undefined {
  const value = hash.replace(/^#/u, '')
  if (value === 'tasks') return 'task'
  return merchantPages.includes(value as MerchantPage) ? value as MerchantPage : undefined
}

export function merchantRouteFromLocation(location: Pick<Location, 'hash' | 'pathname' | 'search'>): MerchantRoute {
  const match = location.pathname.match(/\/merchant\/(overview|products|tasks(?:\/new|\/[^/?#]+)?|publish|rules)\/?$/u)
  const params = new URLSearchParams(location.search)
  const segment = match?.[1]
  if (segment === 'overview') return { page: 'overview', searchQuery: '' }
  if (segment === 'products') {
    const entry = merchantEntryPointFromQuery(params.get('section'))
    return { page: 'products', searchQuery: params.get('q') ?? '', ...(entry ? { entry } : {}) }
  }
  if (segment === 'publish') return { page: 'publish', searchQuery: '' }
  if (segment === 'rules') {
    const productId = params.get('product_id')?.trim()
    return { page: 'rules', searchQuery: '', ...(productId ? { target: { kind: 'product' as const, productId, platform: platformFromQuery(params.get('platform')), accountId: params.get('account_id')?.trim() || undefined } } : {}) }
  }
  if (segment === 'tasks') return { page: 'task', searchQuery: '' }
  if (segment === 'tasks/new') {
    const productId = params.get('product_id')?.trim()
    return {
      page: 'task',
      searchQuery: '',
      ...(productId ? { target: { kind: 'product' as const, productId, platform: platformFromQuery(params.get('platform')), accountId: params.get('account_id')?.trim() || undefined, intentKey: params.get('intent')?.trim() || undefined } } : {}),
    }
  }
  if (segment?.startsWith('tasks/')) {
    const encodedTaskId = segment.slice('tasks/'.length)
    try {
      const taskId = decodeURIComponent(encodedTaskId).trim()
      return { page: 'task', searchQuery: '', ...(taskId ? { target: { kind: 'task' as const, taskId } } : {}) }
    } catch {
      return { page: 'task', searchQuery: '' }
    }
  }
  return { page: legacyPage(location.hash) ?? 'overview', searchQuery: '' }
}

export function urlForMerchantRoute(
  location: Pick<Location, 'pathname' | 'search'>,
  route: { page: MerchantPage; target?: MerchantRouteTarget; searchQuery?: string; entry?: MerchantEntryPoint },
): string {
  const basePath = merchantRoutePattern.test(location.pathname)
    ? location.pathname.replace(merchantRoutePattern, '')
    : location.pathname.replace(/\/$/u, '')
  const params = new URLSearchParams(location.search)
  for (const key of ['q', 'section', 'product_id', 'platform', 'account_id', 'intent']) params.delete(key)

  let path = `${basePath}/merchant/${route.page === 'task' ? 'tasks' : route.page}`
  if (route.page === 'products' && route.searchQuery?.trim()) params.set('q', route.searchQuery.trim())
  if (route.page === 'products' && route.entry) params.set('section', route.entry)
  if (route.page === 'task' && route.target?.kind === 'task') path += `/${encodeURIComponent(route.target.taskId)}`
  if (route.page === 'task' && route.target?.kind === 'product') {
    path += '/new'
    params.set('product_id', route.target.productId)
    if (route.target.platform) params.set('platform', route.target.platform)
    if (route.target.accountId) params.set('account_id', route.target.accountId)
    if (route.target.intentKey) params.set('intent', route.target.intentKey)
  }
  if (route.page === 'rules' && route.target?.kind === 'product') {
    params.set('product_id', route.target.productId)
    if (route.target.platform) params.set('platform', route.target.platform)
    if (route.target.accountId) params.set('account_id', route.target.accountId)
  }
  const query = params.toString()
  return `${path}${query ? `?${query}` : ''}`
}
