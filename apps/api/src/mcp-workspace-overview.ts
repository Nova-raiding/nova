import type { IncomingMessage } from 'node:http'
import { confirmedStoreBrandClues } from '../../../packages/application/src/brand-extractor.js'
import { isTrustedCleanAsset, type MerchantService, type Platform } from '../../../packages/application/src/service.js'
import { inspectStoreLinks } from '../../../packages/domain/src/onboarding.js'
import { evaluatePlatformModelGate, evaluatePlatformModelRelayGate } from '../../../packages/ai/src/platform-model-gate.js'
import type { ApiPersistence, WorkspaceOnboardingState, MerchantOnboardingProjection } from './server.js'

type StoreDirectory = ReturnType<typeof import('./server.js').workspaceStoreDirectory>
type CapabilityCard = { id: string; title: string; summary: string; entryMethod: string; readOnly: boolean }
export interface McpWorkspaceOverviewDependencies {
  workspaceStoreDirectory: (workspaceId: string) => StoreDirectory
  workspaceOnboarding: (workspaceId: string, directory: StoreDirectory) => WorkspaceOnboardingState
  merchantOnboardingProjection: (state: WorkspaceOnboardingState) => MerchantOnboardingProjection
  service: Pick<MerchantService, 'listSyncJobs' | 'listProducts' | 'getBrandProfile' | 'listAssets'>
  trustedPlatformRuleSyncStatuses: (workspaceId: string) => Promise<Array<{ platform: Platform; state: string }>>
  setupDiagnostics: () => ReturnType<typeof import('./health-setup.js').setupDiagnostics>
  persistence: ApiPersistence
  memoryWorkspaceContentSetup: NonNullable<ApiPersistence['workspaceContentSetup']>
  accessibleBrandNavigation: (req: IncomingMessage, workspaceId: string) => Promise<unknown>
  runtimeHealth: () => ReturnType<typeof import('./server.js').runtimeHealth>
  persistenceError: unknown
  invalidDurableSnapshots: Map<string, Array<{ entityType: string; entityId: string; missing: string[] }>>
  getWorkspaceStatus: (workspaceId: string) => Promise<'active' | 'disabled'>
  trustedActiveRuleVersionsForWorkspace: (workspaceId: string) => Promise<unknown>
  SUPPORTED_PLATFORMS: readonly Platform[]
  workspaceConnectorReadiness: (platform: Platform) => unknown
  workspacePlatformStatus: (workspaceId: string) => unknown
  memoryCommercial: NonNullable<ApiPersistence['commercial']>
  MERCHANT_CAPABILITY_CARDS: readonly CapabilityCard[]
  result: (value: unknown) => void
}

export async function handleMcpWorkspaceOverview(method: 'onboarding.status' | 'workspace.health', params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, deps: McpWorkspaceOverviewDependencies): Promise<void> {
  const { workspaceStoreDirectory, workspaceOnboarding, merchantOnboardingProjection, service,
    trustedPlatformRuleSyncStatuses, setupDiagnostics, persistence, memoryWorkspaceContentSetup,
    accessibleBrandNavigation, runtimeHealth, persistenceError, invalidDurableSnapshots,
    getWorkspaceStatus, trustedActiveRuleVersionsForWorkspace, SUPPORTED_PLATFORMS,
    workspaceConnectorReadiness, workspacePlatformStatus, memoryCommercial,
    MERCHANT_CAPABILITY_CARDS, result } = deps
  const directory = workspaceStoreDirectory(workspaceId)
  const onboardingState = workspaceOnboarding(workspaceId, directory)
  const onboarding = onboardingState.steps
  const onboardingV2 = merchantOnboardingProjection(onboardingState)
  if (method === 'onboarding.status') {
    const officialStores = directory.filter(store => store.dataMode === 'official_api' && store.readable)
    const storeKeys = new Set(officialStores.map(store => `${store.platform}:${store.accountId}`))
    const succeededSyncKeys = new Set(service.listSyncJobs(workspaceId).filter(job => job.state === 'succeeded' && storeKeys.has(`${job.platform}:${job.accountId}`)).map(job => `${job.platform}:${job.accountId}`))
    const scannedProducts = service.listProducts(workspaceId).filter(product => product.source === 'official_api' && product.accountId && succeededSyncKeys.has(`${product.platform}:${product.accountId}`))
    const allStoresSynced = officialStores.length > 0 && succeededSyncKeys.size === officialStores.length
    const allStoresScanned = allStoresSynced && scannedProducts.length > 0
    const confirmedProducts = scannedProducts.filter(product => product.factsConfirmed)
    const brandClues = confirmedStoreBrandClues(confirmedProducts)
    const knowledgeReady = allStoresScanned && confirmedProducts.length === scannedProducts.length
    const brandReady = Boolean(service.getBrandProfile(workspaceId))
    const ruleStatuses = await trustedPlatformRuleSyncStatuses(workspaceId)
    const selectedPlatforms = new Set(officialStores.map(store => store.platform))
    const rulesReady = selectedPlatforms.size > 0 && [...selectedPlatforms].every(platform => ruleStatuses.some(rule => rule.platform === platform && rule.state === 'ready'))
    const relayReady = evaluatePlatformModelRelayGate(process.env).ready
    const modalitiesReady = (['text', 'image', 'video'] as const).every(kind => evaluatePlatformModelGate(process.env, kind).ready)
    const setup = setupDiagnostics()
    const costReady = setup.ai.costGate === 'ready'
    const storageReady = setup.objectStorage.configured
    const pointBalance = await persistence.creativePoints?.getBalance(workspaceId)
    const pointsReady = pointBalance?.availablePoints !== null && pointBalance !== undefined && pointBalance.availablePoints > 0
    const configurationReady = knowledgeReady && brandReady && rulesReady && relayReady && modalitiesReady && costReady && storageReady && pointsReady
    const contentSetup = await (persistence.workspaceContentSetup ?? memoryWorkspaceContentSetup).get(workspaceId)
    const contentSetupStoreReady = Boolean(contentSetup && officialStores.some(store => store.platform === contentSetup.platform && store.accountId === contentSetup.accountId))
    const trustedBrandMaterials = service.listAssets(workspaceId).filter(asset => isTrustedCleanAsset(asset) && asset.parseStatus === 'succeeded')
    const configurationNextAction = !knowledgeReady
      ? { method: 'catalog.search', label: '核对商品事实', required_inputs: ['platform', 'account_id'] }
      : !brandReady && trustedBrandMaterials.length
        ? { method: 'brand.extract', label: '核对品牌资料', required_inputs: [] }
        : !brandReady && brandClues.totalCandidates
          ? { method: 'brand.upsert', label: '确认品牌名称', required_inputs: ['name'] }
          : !brandReady
            ? { method: 'asset.upload', label: '补充品牌资料', required_inputs: ['name', 'mime_type'] }
            : { method: 'workspace.health', label: '检查并恢复系统配置', required_inputs: [] }
    const initializationSteps = [
      { id: 'connect_stores', title: '连接平台及店铺', state: officialStores.length ? 'complete' : 'required', summary: officialStores.length ? `已核验 ${officialStores.length} 家官方授权、可读取的店铺` : '还没有可核验的官方授权店铺；店铺链接只用于识别', next_action: { method: 'platform.connect', label: '开始配置店铺', required_inputs: ['platform'] } },
      { id: 'scan_catalog', title: '扫描商品至知识库', state: !officialStores.length ? 'pending' : allStoresSynced ? 'complete' : 'required', summary: !officialStores.length ? '等待店铺授权' : allStoresSynced ? `已完成 ${officialStores.length} 家店铺的官方同步，读取 ${scannedProducts.length} 件商品${scannedProducts.length ? '' : '；暂无可核验商品'}` : `已完成 ${succeededSyncKeys.size}/${officialStores.length} 家店铺的官方同步；待继续扫描`, next_action: { method: 'catalog.sync.start', label: '扫描店铺商品', required_inputs: ['platform', 'account_id'] } },
      { id: 'check_configuration', title: '检查系统配置', state: !allStoresSynced ? 'pending' : configurationReady ? 'complete' : 'blocked', summary: !allStoresSynced ? '等待全部店铺商品扫描' : !scannedProducts.length ? '店铺同步已完成，但暂无可核验商品；请核对授权读取范围或补充商品，内容生产保持阻断' : configurationReady ? '商品事实、品牌档案、平台签名规则、创意点、中转模型、成本与存储门禁已核验；正式生成仍要检查实际调用' : `待处理：${!knowledgeReady ? `商品事实 ${confirmedProducts.length}/${scannedProducts.length}；` : ''}${!brandReady ? '品牌基础档案；' : ''}${!rulesReady ? '平台签名规则；' : ''}${!pointsReady ? '创意点；' : ''}${!relayReady ? '模型中转；' : ''}${!modalitiesReady ? '文案/图片/视频模型；' : ''}${!costReady ? '模型成本门禁；' : ''}${!storageReady ? '对象存储；' : ''}`.replace(/；$/u, ''), next_action: configurationNextAction },
      { id: 'build_workspace', title: '建立工作区', state: !configurationReady || !allStoresSynced ? 'pending' : contentSetupStoreReady ? 'complete' : 'required', summary: configurationReady && allStoresSynced ? contentSetupStoreReady ? `「${contentSetup!.displayName}」已由商家确认，店铺范围已核验；可以选择首个商品任务` : `当前身份已安全绑定工作区；建议名称：${officialStores[0]?.label || '首家店铺'}内容工作区。请确认名称和对应店铺；未保存前不能宣称 4/4。` : '等待前述检查；已有工作区绑定会安全保留', next_action: { method: 'workspace.content_setup.confirm', label: '确认内容工作区', required_inputs: ['display_name', 'platform', 'account_id'] } },
    ] as const
    const initializationCurrent = initializationSteps.find(step => step.state !== 'complete') ?? initializationSteps.at(-1)!
    const current = onboardingV2.current_step
    const bindingByStep: Record<string, string> = {
      workspace: '工作区：绑定 MERCHANT_WORKSPACE_ID；身份由当前认证会话提供。',
      connect_store: '店铺：选择平台后通过官方 OAuth 授权，不需要提供平台密码。',
      select_product: '商品：绑定 platform + account_id 后同步或导入商品。',
      add_assets: '素材：上传图片/资料，等待扫描、权益和事实确认。',
      generate_review: '内容：确认商品事实后创建任务，生成结果仍需审核。',
      publish: '发布：通过审核后查看预检，必须单独确认才能发布。',
    }
    return result({
      schema_version: 'onboarding.status.v1',
      status: current.state === 'complete' ? 'ready' : 'in_progress',
      current_step: current,
      steps: onboardingV2.steps,
      binding: bindingByStep[current.id] ?? '按当前步骤完成配置。',
      next_action: current.primary_action,
      summary: onboardingState.summary,
      ...(typeof params.store_links_text === 'string' ? { store_link_inspection: inspectStoreLinks(params.store_links_text) } : {}),
      initialization: { schema_version: 'store-nova.initialization.v1', status: initializationSteps.every(step => step.state === 'complete') ? 'ready' : initializationCurrent.state === 'blocked' ? 'blocked' : 'in_progress', completed: initializationSteps.filter(step => step.state === 'complete').length, total: 4, current_step: initializationCurrent, steps: initializationSteps, security_notice: '请通过平台官方页面授权，不要在对话中发送店铺密码或验证码。', brand_clues: brandClues, evidence: { official_stores: officialStores.length, successful_sync_stores: succeededSyncKeys.size, scanned_products: scannedProducts.length, confirmed_products: confirmedProducts.length, brand_candidate_count: brandClues.totalCandidates, sku_records: scannedProducts.reduce((sum, product) => sum + (product.skus?.length ?? 0), 0), image_references: scannedProducts.reduce((sum, product) => sum + (product.images?.length ?? 0), 0), products_missing_images: scannedProducts.filter(product => !product.images?.length).length, brand_profile_present: brandReady, content_workspace_confirmed: contentSetupStoreReady, points_state: pointBalance?.availablePoints === null || !pointBalance ? 'unknown' : pointsReady ? 'ready' : 'insufficient', rules_ready: rulesReady, relay_ready: relayReady, modalities_ready: modalitiesReady, cost_ready: costReady, storage_ready: storageReady } },
      guidance: '完成当前步骤后重新检查引导状态；未完成前不会执行生成或发布。',
    })
  }
  const brandNavigation = await accessibleBrandNavigation(req, workspaceId)
  return result({
  ...runtimeHealth(),
  persistence: { mode: persistence.mode, ready: !persistenceError, ...(invalidDurableSnapshots.get(workspaceId)?.length ? { invalidSnapshots: invalidDurableSnapshots.get(workspaceId) } : {}) },
  plugin: { name: 'merchant-marketing', version: '0.1.0' },
  mcp: { status: 'ready', transport: '/mcp' },
  workspace: { id: workspaceId, status: (await getWorkspaceStatus(workspaceId)) === 'active' ? 'ready' : 'disabled' },
  // Keep overview's rule projection on the same durable, trusted source
  // as MCP rule.list. Do not expose in-memory/manual fixture versions as
  // if they were platform policy evidence.
  rules: { activeVersions: await trustedActiveRuleVersionsForWorkspace(workspaceId) },
  ruleSync: await trustedPlatformRuleSyncStatuses(workspaceId),
  connectorReadiness: Object.fromEntries(SUPPORTED_PLATFORMS.map(platform => [platform, workspaceConnectorReadiness(platform)])),
  platforms: workspacePlatformStatus(workspaceId),
  commercial: { settings: await (persistence.commercial ?? memoryCommercial).getSettings(workspaceId), platforms: await (persistence.commercial ?? memoryCommercial).listPlatformSettings(workspaceId) },
  storeDirectory: directory,
  onboarding_v2: onboardingV2,
  storeSelection: { requiredForStoreActions: true, key: 'platform + accountId', warning: '别名和店铺名只用于展示与候选匹配，不能替代账号范围确认' },
  capabilityCards: {
    title: 'Store Nova 工作台',
    presentation: 'conversation_cards',
    instruction: '优先展示这些卡片；商家选择卡片后再调用 entryMethod，不要求商家记忆工具名或内部 ID。店铺级操作先展示导航列表并确认平台与账号范围。',
    navigation: {
      title: '平台与店铺',
      presentation: 'grouped_list',
      selectionKey: 'platform + accountId',
      items: [
        { id: 'all-stores', title: '全部店铺', scope: 'workspace', action: { method: 'catalog.search', arguments: { scope: 'workspace' } } },
        ...directory.map(store => ({
          id: `store:${store.platform}:${store.accountId}`,
          title: store.label,
          platform: store.platform,
          accountId: store.accountId,
          state: store.state,
          dataMode: store.dataMode,
          readable: store.readable,
          writeEnabled: store.writeEnabled,
          action: { method: 'catalog.search', arguments: { scope: 'store', platform: store.platform, account_id: store.accountId } },
        })),
      ],
      emptyState: '尚未绑定店铺；先选择平台并完成官方授权，再同步商品。',
    },
    brandNavigation: { title: '我的品', presentation: 'tree', hierarchy: ['brand', 'platform', 'store'], items: brandNavigation, emptyState: '尚未创建品；先调用 brand-unit.create，再调用 brand-unit.bind-store。' },
    onboarding,
    cards: MERCHANT_CAPABILITY_CARDS.map(card => ({ ...card, writeGate: card.readOnly ? 'none' : 'interactive_confirmation' })),
  },
})
}
