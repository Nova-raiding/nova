import { merchantEntryPointFromQuery, type MerchantEntryPoint } from './entry-points.js'

export const merchantPages = ['overview', 'products', 'finance', 'members', 'task', 'publish', 'rules'] as const
export type MerchantPage = (typeof merchantPages)[number]
export type MerchantPlatformId = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'

export type MerchantRouteTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'product'; productId: string; platform?: MerchantPlatformId; accountId?: string; intentKey?: string }

export interface MerchantCatalogContext {
  platform?: MerchantPlatformId
  accountId?: string
  productId?: string
  intent?: 'authorization'
}

export interface MerchantRoute {
  page: MerchantPage
  target?: MerchantRouteTarget
  /** Platform scope for Rules URLs that do not target a specific product. */
  rulesPlatform?: MerchantPlatformId
  searchQuery: string
  entry?: MerchantEntryPoint
  imageJobId?: string
  publishJobId?: string
  catalogContext?: MerchantCatalogContext
}

/** Resolve programmatic sidebar destinations to their durable page. */
export function merchantNavigationPage(page: MerchantPage): MerchantPage {
  return page === 'publish' ? 'products' : page
}

export interface MerchantRiskDestinationInput {
  type: string
  title?: string
  entityType?: string
  entityId?: string
  platform?: string
  accountId?: string
  evidence?: { taskId?: string; [key: string]: unknown }
}

export type MerchantRiskDestination =
  | { page: 'overview' }
  | { page: 'task'; target: { kind: 'task'; taskId: string } }
  | { page: 'products'; entry: MerchantEntryPoint; searchQuery?: string; catalogContext?: MerchantCatalogContext }

export function merchantRiskDestination(issue: MerchantRiskDestinationInput): MerchantRiskDestination {
  const platform = issue.platform && platforms.has(issue.platform as MerchantPlatformId)
    ? issue.platform as MerchantPlatformId
    : undefined
  const accountId = typeof issue.accountId === 'string' ? issue.accountId.trim() : ''
  const storeContext = {
    ...(platform ? { platform } : {}),
    ...(accountId ? { accountId } : {}),
  }
  const hasProductRiskCode = ['LOW_STOCK', 'MISSING_IMAGES'].includes(issue.type)
  if (hasProductRiskCode && issue.entityType !== undefined && issue.entityType !== 'product') {
    return { page: 'overview' as const }
  }
  if (issue.entityType === 'content_version' || issue.entityType === 'publish_job') {
    const taskId = typeof issue.evidence?.taskId === 'string' ? issue.evidence.taskId.trim() : ''
    if (taskId) return { page: 'task' as const, target: { kind: 'task' as const, taskId } }
  }
  if (issue.type === 'AUTH_RECONNECT' && issue.entityType === 'platform_account') {
    return {
      page: 'products' as const,
      entry: 'products' as const,
      catalogContext: { ...storeContext, intent: 'authorization' as const },
    }
  }
  // Older metrics projections may omit entityType even though their stable
  // risk code still identifies a product row. Preserve both the server title
  // and product/store identity when navigating into the catalog.
  const isProductRisk = issue.entityType === 'product' || (issue.entityType === undefined && hasProductRiskCode)
  if (isProductRisk) {
    const title = issue.title?.trim() ?? ''
    const productId = typeof issue.entityId === 'string' ? issue.entityId.trim() : ''
    if (!title && !productId) return { page: 'overview' as const }
    const catalogContext = {
      ...storeContext,
      ...(productId ? { productId } : {}),
    }
    return {
      page: 'products' as const,
      entry: 'products' as const,
      ...(title ? { searchQuery: title } : {}),
      ...(Object.keys(catalogContext).length ? { catalogContext } : {}),
    }
  }
  if (issue.entityType === 'platform_account' || issue.entityType === 'sync_job') {
    return {
      page: 'products' as const,
      entry: 'products' as const,
      ...(Object.keys(storeContext).length ? { catalogContext: storeContext } : {}),
    }
  }
  return { page: 'overview' as const }
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
const merchantRoutePattern = /\/merchant\/(?:overview|products|finance|members|tasks(?:\/new|\/[^/?#]+)?|publish|rules)\/?$/u

function platformFromQuery(value: string | null): MerchantPlatformId | undefined {
  return value && platforms.has(value as MerchantPlatformId) ? value as MerchantPlatformId : undefined
}

function legacyPage(hash: string): MerchantPage | undefined {
  const value = hash.replace(/^#/u, '')
  if (value === 'tasks') return 'task'
  return merchantPages.includes(value as MerchantPage) ? value as MerchantPage : undefined
}

export function merchantRouteFromLocation(location: Pick<Location, 'hash' | 'pathname' | 'search'>): MerchantRoute {
  const match = location.pathname.match(/\/merchant\/(overview|products|finance|members|tasks(?:\/new|\/[^/?#]+)?|publish|rules)\/?$/u)
  const params = new URLSearchParams(location.search)
  const segment = match?.[1]
  if (segment === 'overview') return { page: 'overview', searchQuery: '' }
  if (segment === 'finance') return { page: 'finance', searchQuery: '' }
  if (segment === 'members') return { page: 'members', searchQuery: '' }
  if (segment === 'products') {
    // Direct links open the materials workspace; the catalog remains available
    // through its explicit screenshot-backed section=products entry.
    const entry = merchantEntryPointFromQuery(params.get('section')) ?? 'knowledge'
    const platform = platformFromQuery(params.get('platform'))
    const accountId = params.get('account_id')?.trim()
    const productId = params.get('product_id')?.trim()
    const intent = params.get('intent') === 'authorization' ? 'authorization' as const : undefined
    const catalogContext = platform || accountId || productId || intent
      ? {
          ...(platform ? { platform } : {}),
          ...(accountId ? { accountId } : {}),
          ...(productId ? { productId } : {}),
          ...(intent ? { intent } : {}),
        }
      : undefined
    return { page: 'products', searchQuery: params.get('q') ?? '', entry, ...(catalogContext ? { catalogContext } : {}) }
  }
  // The legacy rules URL resolves to the dedicated rules page. Preserve
  // product/store context in the URL so direct loads and refreshes keep the
  // same scoped rule workflow as programmatic navigation.
  if (segment === 'rules') {
    const productId = params.get('product_id')?.trim()
    const platform = platformFromQuery(params.get('platform'))
    const rulesPlatform = platformFromQuery(params.get('rules_platform')) ?? (!productId ? platform : undefined)
    const accountId = params.get('account_id')?.trim()
    return {
      page: 'rules',
      searchQuery: '',
      ...(rulesPlatform ? { rulesPlatform } : {}),
      ...(productId ? {
        target: {
          kind: 'product' as const,
          productId,
          ...(platform ? { platform } : {}),
          ...(accountId ? { accountId } : {}),
        },
      } : {}),
    }
  }
  if (segment === 'publish') return { page: 'products', searchQuery: '' }
  if (segment === 'tasks') {
    const imageJobId = params.get('image_job')?.trim()
    // `/merchant/tasks` is the durable task workspace entry, including its
    // image-job discovery/empty state. Returning products here made the
    // workspace impossible to restore from a direct link or browser refresh.
    const publishJobId = params.get('publish_job_id')?.trim()
    return { page: 'task', searchQuery: '', ...(imageJobId ? { imageJobId } : {}), ...(publishJobId ? { publishJobId } : {}) }
  }
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
  route: { page: MerchantPage; target?: MerchantRouteTarget; searchQuery?: string; entry?: MerchantEntryPoint; imageJobId?: string; publishJobId?: string; catalogContext?: MerchantCatalogContext; rulesPlatform?: MerchantPlatformId },
): string {
  const basePath = merchantRoutePattern.test(location.pathname)
    ? location.pathname.replace(merchantRoutePattern, '')
    : location.pathname.replace(/\/$/u, '')
  const params = new URLSearchParams(location.search)
  // image_job is a transient deep-link consumed by the task workspace.  It
  // must not leak into later navigation (for example when opening the task
  // list or publish center), otherwise the old job panel reappears unexpectedly.
  for (const key of ['q', 'section', 'product_id', 'platform', 'account_id', 'intent', 'image_job', 'publish_job_id', 'rules_platform']) params.delete(key)

  let path = `${basePath}/merchant/${route.page === 'task' ? 'tasks' : route.page}`
  if (route.page === 'products' && route.searchQuery?.trim()) params.set('q', route.searchQuery.trim())
  if (route.page === 'products' && route.entry) params.set('section', route.entry)
  if (route.page === 'products' && route.catalogContext?.platform && platforms.has(route.catalogContext.platform)) params.set('platform', route.catalogContext.platform)
  if (route.page === 'products' && route.catalogContext?.accountId?.trim()) params.set('account_id', route.catalogContext.accountId.trim())
  if (route.page === 'products' && route.catalogContext?.productId?.trim()) params.set('product_id', route.catalogContext.productId.trim())
  if (route.page === 'products' && route.catalogContext?.intent === 'authorization') params.set('intent', 'authorization')
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
  if (route.page === 'rules' && route.rulesPlatform && platforms.has(route.rulesPlatform)) {
    params.set(route.target?.kind === 'product' ? 'rules_platform' : 'platform', route.rulesPlatform)
  }
  if (route.page === 'task' && route.imageJobId?.trim()) params.set('image_job', route.imageJobId.trim())
  if (route.page === 'task' && !route.target && route.publishJobId?.trim()) params.set('publish_job_id', route.publishJobId.trim())
  const query = params.toString()
  return `${path}${query ? `?${query}` : ''}`
}

/** Update the durable product search without creating a history entry per keystroke. */
export function urlForMerchantCatalogSearch(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  query: string,
): string {
  const route = merchantRouteFromLocation(location)
  return urlForMerchantRoute(location, {
    ...route,
    page: 'products',
    searchQuery: query,
    entry: route.page === 'products' ? route.entry : 'products',
  })
}

/** Open a store as a durable catalog deep link and discard stale product/search scope. */
export function urlForMerchantCatalogStore(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  store: { platform: MerchantPlatformId; accountId: string },
): string {
  const route = merchantRouteFromLocation(location)
  return urlForMerchantRoute(location, {
    page: 'products',
    entry: route.page === 'products' ? route.entry : 'products',
    catalogContext: { platform: store.platform, accountId: store.accountId },
  })
}

/** Return to store selection, retaining the platform filter but dropping store/product/search scope. */
export function urlForMerchantCatalogStoreSelection(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
): string {
  const route = merchantRouteFromLocation(location)
  return urlForMerchantRoute(location, {
    page: 'products',
    entry: route.page === 'products' ? route.entry : 'products',
    catalogContext: route.page === 'products' && route.catalogContext?.platform
      ? { platform: route.catalogContext.platform }
      : undefined,
  })
}

/** Return from a product detail to its store list without losing the active search or store scope. */
export function urlForMerchantCatalogProductList(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
): string {
  const route = merchantRouteFromLocation(location)
  const storeContext = route.catalogContext && (route.catalogContext.platform || route.catalogContext.accountId || route.catalogContext.intent)
    ? {
        ...(route.catalogContext.platform ? { platform: route.catalogContext.platform } : {}),
        ...(route.catalogContext.accountId ? { accountId: route.catalogContext.accountId } : {}),
        ...(route.catalogContext.intent ? { intent: route.catalogContext.intent } : {}),
      }
    : undefined
  return urlForMerchantRoute(location, {
    page: 'products',
    entry: route.page === 'products' ? route.entry : 'products',
    searchQuery: route.searchQuery,
    ...(storeContext ? { catalogContext: storeContext } : {}),
  })
}
