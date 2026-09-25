import { DomainError, MANUAL_STORE_RECORD_TOKEN_STATE, assetReadiness, type MerchantService, type Platform, type PlatformAccount } from '../../../packages/application/src/service.js'
import { type ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'
import { isProductionCanaryReady } from '../../../packages/connectors/src/index.js'
import { platformWriteAllowed } from '../../../packages/connectors/src/write-boundary.js'

type PublicPlatformAccount = Omit<PlatformAccount, 'credentialRef'> & { credentialRef?: undefined }

export function createPlatformWorkspaceRuntime(deps: {
  service: MerchantService
  connectorRuntime: ConnectorRuntime
  fixtureMode: boolean
  manualPlatformOperationsMode: boolean
  supportedPlatforms: readonly Platform[]
  platformLabels: Readonly<Record<Platform, string>>
  isProduction: () => boolean
  manualPlatformOperations: () => boolean
  storeGrantsPlatformScope: (tokenState: string) => boolean
}) {
  function fixturePlatformEnabled(_platform: Platform) {
    // The disposable fixture environment intentionally exposes an independent
    // fake connector for every supported platform so the six-platform UI flow
    // can be exercised without mistaking it for production readiness.
    return deps.fixtureMode
  }

  function manualPlatformEnabled(_platform: Platform) {
    return deps.manualPlatformOperationsMode && !deps.fixtureMode
  }

  function platformConnectorConfigured(platform: Platform) {
    return fixturePlatformEnabled(platform) || (!manualPlatformEnabled(platform) && deps.connectorRuntime.canRead(platform))
  }

  function platformAuthorizationConfigured(platform: Platform) {
    return fixturePlatformEnabled(platform) || deps.connectorRuntime.isOAuthConfigured(platform)
  }

  function fixtureAccountId(workspaceId: string, platform: Platform) {
    return `fixture_${workspaceId}_${platform}`
  }

  function defaultFixtureAccountId(workspaceId: string, platform: Platform) {
    const accounts = deps.service.listPlatformAccounts(workspaceId).filter(account => account.platform === platform)
    const existing = accounts.find(account => account.tokenState === 'connected') ?? accounts.find(account => account.tokenState !== 'revoked')
    return existing?.id ?? fixtureAccountId(workspaceId, platform)
  }

  function connectedPlatformAccountId(workspaceId: string, platform: Platform) {
    return deps.service.listPlatformAccounts(workspaceId).find(account => account.platform === platform && account.tokenState === 'connected')?.id
  }

  function requireActivePlatformAccount(workspaceId: string, accountId: string, platform: Platform) {
    try {
      return deps.service.getActionablePlatformAccount(workspaceId, accountId, platform)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PLATFORM_ACCOUNT_NOT_FOUND') {
        throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `请先在 Codex 中完成${platform}店铺授权，再同步商品`, 400)
      }
      throw error
    }
  }

  function resolveTaskAccountId(_workspaceId: string, _platform: Platform, requested?: string) {
    // Never select the first connected account. Product-bound context is
    // enforced by the domain service; unbound products remain unbound until the
    // merchant explicitly selects a platform + accountId pair.
    return requested?.trim()
  }

  function resolveProductTaskAccount(workspaceId: string, platform: Platform, productId: string, requested?: string) {
    const explicit = resolveTaskAccountId(workspaceId, platform, requested)
    const product = deps.service.products.get(productId)
    if (product?.workspaceId === workspaceId && product.platform === platform && product.accountId) return product.accountId
    return explicit
  }

  function requireProductionTaskStore(platform: Platform, accountId: string | undefined) {
    if (deps.isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `生产任务必须绑定已授权的${platform}店铺`, 400, { platform, next_action: '选择 platform + account_id 后重新创建任务' })
  }

  function requireProductionRequestStores(workspaceId: string, understanding: ReturnType<MerchantService['understandTaskRequest']>) {
    if (!deps.isProduction()) return
    for (const child of understanding.executionPlan.childTasks) {
      const productId = child.candidateProductIds[0]
      const product = productId ? deps.service.products.get(productId) : undefined
      requireProductionTaskStore(child.platform, product?.workspaceId === workspaceId && product.platform === child.platform ? product.accountId : undefined)
    }
  }

  function platformAccessFlags(platform: Platform, account: { tokenState: string } | undefined) {
    const active = account?.tokenState === 'connected'
    return {
      readEnabled: active && (fixturePlatformEnabled(platform) || platformConnectorConfigured(platform)),
      writeEnabled: active && platformWriteReady(platform),
    }
  }

  function platformWriteReady(platform: Platform) {
    return platformWriteAllowed({ production: deps.isProduction(), fixtureMode: deps.fixtureMode, connectorConfigured: platformConnectorConfigured(platform), pluginWriteEnabled: process.env.PLUGIN_WRITE_ENABLED === 'true', canaryReady: isProductionCanaryReady(deps.connectorRuntime.capabilityEvidence[platform], platform) })
  }

  function workspaceConnectorReadiness(platform: Platform) {
    const media = deps.connectorRuntime.mediaUploadReadiness(platform)
    const mediaUpload = {
      ...media,
      ...(media.ready ? {} : { reason: !media.configured ? '主图/副图上传路径或回执映射未配置' : !media.evidence ? '主图/副图上传证据未通过门禁' : '主图/副图媒体连接器未就绪' }),
    }
    if (fixturePlatformEnabled(platform)) {
      return { platform, ready: true, reasons: ['FIXTURE_MODE'], verifiedCapabilities: [], mediaUpload: { configured: false, evidence: false, ready: false, reason: 'fixture 模式不计入真实媒体上传证据' } }
    }
    return { ...deps.connectorRuntime.readiness[platform], mediaUpload }
  }

  function workspacePlatformStatus(workspaceId: string) {
    const registered = deps.service.listPlatformAccounts(workspaceId)
    return deps.supportedPlatforms.map(platform => {
      const accounts = registered.filter(item => item.platform === platform)
      const fixture = fixturePlatformEnabled(platform)
      const connectedAccountCount = accounts.filter(account => account.tokenState === 'connected').length
      const configuredState = deps.connectorRuntime.isOAuthConfigured(platform) && !deps.connectorRuntime.credentialProviderConfigured
        ? 'configured_provider_required'
        : deps.connectorRuntime.isHttpConfigured(platform)
          ? 'configured'
          : deps.connectorRuntime.isOAuthConfigured(platform)
            ? 'oauth_configured'
            : 'not_configured'
      const manual = manualPlatformEnabled(platform)
      const state = manual
        ? 'manual_operations'
        : fixture
        ? 'fixture_ready'
        : accounts.length === 0
          ? configuredState
          : connectedAccountCount === accounts.length
            ? 'connected'
            : connectedAccountCount > 0
              ? 'partially_connected'
              : accounts.some(account => account.tokenState === 'refresh_required')
                ? 'refresh_required'
                : accounts.some(account => account.tokenState === 'revoked')
                  ? 'revoked'
                  : accounts[0]!.tokenState
      const access = accounts.map(account => platformAccessFlags(platform, account))
      const readEnabled = access.length > 0 && access.every(item => item.readEnabled)
      const writeEnabled = access.length > 0 && access.every(item => item.writeEnabled)
      const officialReadCount = accounts.filter(account => account.tokenState === 'connected' && deps.connectorRuntime.canRead(platform)).length
      return {
        platform,
        state,
        accountCount: accounts.length,
        connectedAccountCount,
        // Platform readiness is a six-row summary. Store identities and mixed
        // account states remain available through storeDirectory.
        dataMode: manual ? 'manual_upload' : fixture ? 'fixture' : accounts.length === 0 ? 'unavailable' : officialReadCount === accounts.length ? 'official_api' : officialReadCount > 0 ? 'mixed' : 'account_record_only',
        simulated: fixture,
        readEnabled,
        writeEnabled,
        readiness: workspaceConnectorReadiness(platform),
        capabilityEvidenceKind: 'application_profile',
        capabilities: deps.connectorRuntime.capabilityMatrix(platform).map(item => ({ capability: item.capability, state: item.state, ...(item.verifiedAt ? { verifiedAt: item.verifiedAt } : {}) })),
      }
    })
  }

  function publicAuthorization(account: PublicPlatformAccount, simulated: boolean) {
    const expiresAt = account.accessTokenExpiresAt
    const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
    const lastKnownExpiryState = !Number.isFinite(expiry) ? 'unknown' : expiry <= Date.now() ? 'expired' : 'valid'
    return {
      state: simulated ? 'fixture' : account.tokenState,
      reauthorizationRequired: account.tokenState === 'refresh_required' || account.tokenState === 'revoked',
      grantedScopes: account.grantedScopes ?? [],
      scopeState: account.grantedScopes?.length ? 'reported_by_provider' : 'unknown',
      lastKnownAccessTokenExpiresAt: expiresAt ?? null,
      lastKnownExpiryState,
      renewalMode: account.credentialRefreshable === true ? 'automatic' : account.credentialRefreshable === false ? 'reauthorize' : 'unknown',
      refreshSupported: account.credentialRefreshable ?? null,
      lastAuthorizedAt: account.lastAuthorizedAt ?? null,
      metadataObservedAt: account.credentialMetadataObservedAt ?? null,
      metadataFreshness: account.credentialMetadataObservedAt ? 'last_known' : 'unknown',
      stateChangedAt: account.tokenStateUpdatedAt ?? null,
      revokedAt: account.revokedAt ?? null,
    }
  }

  function workspaceStoreDirectory(workspaceId: string, platformFilter?: Platform) {
    const products = deps.service.listProducts(workspaceId)
    const syncJobs = deps.service.listSyncJobs(workspaceId)
    const productsByAccount = new Map<string, { storeNames: Set<string>; hasFixtureProduct: boolean }>()
    for (const product of products) {
      if (!product.accountId) continue
      const key = `${product.platform}:${product.accountId}`
      const grouped = productsByAccount.get(key) ?? { storeNames: new Set<string>(), hasFixtureProduct: false }
      if (product.storeName) grouped.storeNames.add(product.storeName)
      if (product.source === 'fixture') grouped.hasFixtureProduct = true
      productsByAccount.set(key, grouped)
    }
    const syncByAccount = new Map<string, { latestAttempt?: typeof syncJobs[number]; lastSuccessful?: typeof syncJobs[number]; lastUsable?: typeof syncJobs[number] }>()
    for (const job of syncJobs) {
      const key = `${job.platform}:${job.accountId}`
      const current = syncByAccount.get(key) ?? {}
      if (!current.latestAttempt || job.updatedAt > current.latestAttempt.updatedAt) current.latestAttempt = job
      if (job.state === 'succeeded' && (!current.lastSuccessful || job.updatedAt > current.lastSuccessful.updatedAt)) current.lastSuccessful = job
      if ((job.state === 'succeeded' || job.state === 'partial') && (!current.lastUsable || job.updatedAt > current.lastUsable.updatedAt)) current.lastUsable = job
      syncByAccount.set(key, current)
    }
    return deps.service.listPlatformAccounts(workspaceId)
      .filter(account => !platformFilter || account.platform === platformFilter)
      .map(account => {
        const productGroup = productsByAccount.get(`${account.platform}:${account.id}`)
        const names = [...(productGroup?.storeNames ?? [])].sort()
        const storeName = names.length === 1 ? names[0]! : names.length > 1 ? `${names[0]} 等 ${names.length} 个店铺名` : undefined
        const state = account.tokenState
        const access = platformAccessFlags(account.platform, account)
        const simulated = deps.fixtureMode || Boolean(productGroup?.hasFixtureProduct)
        const dataMode = simulated ? 'fixture' : access.readEnabled ? 'official_api' : 'account_record_only'
        const syncGroup = syncByAccount.get(`${account.platform}:${account.id}`)
        const latestAttempt = syncGroup?.latestAttempt
        const lastSuccessful = syncGroup?.lastSuccessful
        const lastUsable = syncGroup?.lastUsable
        return {
          platform: account.platform,
          accountId: account.id,
          ...(account.storeAlias ? { alias: account.storeAlias } : {}),
          ...(storeName ? { storeName } : {}),
          label: account.storeAlias ?? storeName ?? `${account.platform} 店铺`,
          state,
          dataMode,
          readable: account.tokenState === 'connected' && (access.readEnabled || simulated),
          writeEnabled: access.writeEnabled,
          authorization: publicAuthorization(account, simulated),
          sync: {
            latestState: latestAttempt?.state ?? null,
            lastAttemptAt: latestAttempt?.updatedAt ?? null,
            lastSuccessfulAt: lastSuccessful?.updatedAt ?? null,
            lastUsableAt: lastUsable?.updatedAt ?? null,
            failedItems: latestAttempt?.itemsFailed ?? 0,
          },
          revision: account.revision,
        }
      })
      .sort((left, right) => `${left.platform}:${left.label}:${left.accountId}`.localeCompare(`${right.platform}:${right.label}:${right.accountId}`))
  }

  function platformAccountAccessItems(workspaceId: string, platformFilter?: Platform) {
    const registered = deps.service.listPlatformAccounts(workspaceId)
    const directory = new Map(workspaceStoreDirectory(workspaceId).map(store => [`${store.platform}:${store.accountId}`, store]))
    return deps.supportedPlatforms
      .filter(platform => !platformFilter || platform === platformFilter)
      .flatMap(platform => {
        const accounts = registered.filter(item => item.platform === platform)
        const rows = accounts.length ? accounts : [undefined]
        return rows.map(account => {
          if (account) return { ...directory.get(`${platform}:${account.id}`), ...platformAccessFlags(platform, account), readiness: workspaceConnectorReadiness(platform) }
          return { platform, state: manualPlatformEnabled(platform) ? 'manual_operations' : fixturePlatformEnabled(platform) ? 'fixture_ready' : deps.connectorRuntime.isOAuthConfigured(platform) && !deps.connectorRuntime.credentialProviderConfigured ? 'configured_provider_required' : deps.connectorRuntime.isHttpConfigured(platform) ? 'configured' : deps.connectorRuntime.isOAuthConfigured(platform) ? 'oauth_configured' : 'not_configured', dataMode: manualPlatformEnabled(platform) ? 'manual_upload' : undefined, ...platformAccessFlags(platform, account), readiness: workspaceConnectorReadiness(platform) }
        })
      })
  }

  function merchantPlatformOptions(workspaceId: string, directory = workspaceStoreDirectory(workspaceId)) {
    return deps.supportedPlatforms.map(platform => {
      const stores = directory.filter(store => store.platform === platform)
      const readiness = workspaceConnectorReadiness(platform)
      const realStore = stores.find(store => store.state === 'connected' && store.dataMode === 'official_api' && store.readable)
      const demoStore = stores.find(store => store.dataMode === 'fixture')
      const state = realStore ? 'connected' : demoStore ? 'demo' : readiness.ready ? 'available' : 'not_configured'
      const mode = realStore ? '真实授权' : demoStore ? '本地演示' : readiness.ready ? '可授权' : '待配置'
      return {
        platform,
        label: deps.platformLabels[platform],
        state,
        mode,
        storeCount: stores.length,
        action: 'platform.connect',
        cta: state === 'connected' ? `管理${deps.platformLabels[platform]}店铺` : `连接${deps.platformLabels[platform]}`,
        nextAction: state === 'not_configured' ? '等待平台官方接口配置' : `选择${deps.platformLabels[platform]}店铺并授权`,
        readiness: { ready: readiness.ready, reasons: readiness.reasons, mediaUpload: readiness.mediaUpload },
      }
    })
  }

  function workspaceOnboarding(workspaceId: string, directory = workspaceStoreDirectory(workspaceId)) {
    const products = deps.service.listProducts(workspaceId)
    const manualOperations = deps.manualPlatformOperations()
    // Which stores this workspace may act on comes from `isUsableStoreAccount`,
    // the same predicate `requireStoreOnboarding` applies, so the onboarding view
    // and the store boundary can no longer report different answers. Manual
    // operations use credential-free, tenant-scoped account records that
    // operations staff assign to a merchant; they identify the target store but
    // never imply an OAuth connection or an official platform receipt.
    const realDirectory = directory.filter(store => store.dataMode === 'official_api' && store.readable)
    const manualDirectory = directory.filter(store => store.state === MANUAL_STORE_RECORD_TOKEN_STATE)
    // Same shared fact as `requireStoreOnboarding`, plus the one pre-existing
    // presentation rule: a fixture store stays visible in the directory but is
    // demo data, never formal onboarding evidence.
    const eligibleDirectory = directory.filter(store => deps.storeGrantsPlatformScope(store.state) && store.dataMode !== 'fixture')
    const selectedStoreKeys = new Set(eligibleDirectory.map(store => `${store.platform}:${store.accountId}`))
    const boundProducts = products.filter(product => product.accountId ? selectedStoreKeys.has(`${product.platform}:${product.accountId}`) : false)
    const assets = deps.service.listAssets(workspaceId)
    const tasks = deps.service.listTasks(workspaceId).filter(task => task.accountId ? selectedStoreKeys.has(`${task.platform}:${task.accountId}`) : false)
    const confirmedProducts = boundProducts.filter(product => product.factsConfirmed)
    const readyAssets = assets.filter(asset => assetReadiness(asset).status === 'ready')
    const deliverableTasks = tasks.filter(task => deps.service.listContentVersions(workspaceId, task.id).some(version => version.state === 'approved' || version.state === 'delivered'))
    const steps = [
      { id: 'workspace', title: '工作区', summary: '当前工作区已建立，后续状态按工作区隔离', state: 'complete', entryMethod: 'workspace.health', nextMethod: 'workspace.health' },
      { id: 'bind-store', title: manualOperations ? '确认运营店铺' : '连接店铺', summary: eligibleDirectory.length ? `已配置 ${eligibleDirectory.length} 家${manualOperations ? '人工运营' : '官方授权'}店铺` : manualOperations ? '请联系平台运营为当前商家建立不含凭据的店铺记录' : directory.length ? '当前只有演示店铺，正式商品任务需要先连接真实店铺' : '先选择平台并完成官方授权', state: eligibleDirectory.length ? 'complete' : 'required', entryMethod: manualOperations ? 'workspace.health' : 'platform.connect', nextMethod: manualOperations ? 'workspace.health' : 'platform.connect' },
      { id: 'choose-product', title: '选择商品', summary: boundProducts.length ? `已找到 ${boundProducts.length} 个商品，可按店铺选择` : manualOperations ? '等待运营导入公开链接或商家提供的商品资料' : '绑定真实店铺后同步或导入商品', state: !eligibleDirectory.length ? 'blocked' : boundProducts.length ? 'next' : 'required', entryMethod: 'catalog.search', nextMethod: 'catalog.search' },
      { id: 'add-assets', title: '上传素材与资料', summary: readyAssets.length ? `已确认 ${readyAssets.length} 份可用素材` : assets.length ? '素材已上传，仍需完成扫描、权益和事实确认' : '添加商品图片、品牌资料和知识库文件', state: !boundProducts.length ? 'blocked' : readyAssets.length ? 'complete' : assets.length ? 'next' : 'required', entryMethod: 'asset.upload', nextMethod: 'asset.upload' },
      { id: 'start-content', title: '生成并审核', summary: deliverableTasks.length ? `已有 ${deliverableTasks.length} 个内容交付` : confirmedProducts.length ? '商品事实已确认，可以开始文案、主图或视频分镜' : '先确认商品、价格、库存和图片事实', state: !boundProducts.length || !confirmedProducts.length ? 'blocked' : deliverableTasks.length ? 'complete' : 'next', entryMethod: 'task.understand', nextMethod: 'task.understand' },
      { id: 'publish', title: '发布', summary: deliverableTasks.length ? '已有已批准交付物，可查看发布前预检' : '完成内容审核后才能进入发布预检', state: deliverableTasks.length ? 'next' : 'blocked', entryMethod: 'publish.prepare', nextMethod: 'publish.prepare' },
    ] as const
    const current = steps.find(step => step.state === 'required' || step.state === 'next' || step.state === 'blocked') ?? steps.at(-1)!
    return { steps, currentStep: { id: current.id, title: current.title, state: current.state, entryMethod: current.entryMethod }, summary: { stores: eligibleDirectory.length, officialStores: realDirectory.length, manualStores: manualDirectory.length, fixtureStores: directory.length - realDirectory.length - manualDirectory.length, products: boundProducts.length, unboundProducts: products.length - boundProducts.length, confirmedProducts: confirmedProducts.length, assets: assets.length, readyAssets: readyAssets.length, tasks: tasks.length, deliverableTasks: deliverableTasks.length } }
  }

  function onboardingPrimaryAction(step: ReturnType<typeof workspaceOnboarding>['steps'][number]) {
    const actions: Record<string, { label: string; requiredInputs: string[] }> = {
      'workspace.health': { label: '查看工作区状态', requiredInputs: [] },
      'platform.connect': { label: '连接平台店铺', requiredInputs: ['platform'] },
      'catalog.search': { label: '选择或导入商品', requiredInputs: ['platform', 'account_id'] },
      'asset.upload': { label: '上传商品资料', requiredInputs: ['name', 'mime_type'] },
      'task.understand': { label: '开始生成并审核', requiredInputs: ['instruction', 'platform', 'account_id', 'product_id'] },
      'publish.prepare': { label: '查看发布预览', requiredInputs: ['task_id'] },
    }
    const action = actions[step.nextMethod] ?? { label: step.title, requiredInputs: [] }
    return { method: step.nextMethod, label: action.label, required_inputs: action.requiredInputs }
  }

  function merchantOnboardingProjection(onboarding: ReturnType<typeof workspaceOnboarding>, sideEffects: 'none' | 'merchant_intent_recorded' | 'workspace_bootstrapped' = 'none') {
    const stepId: Record<string, string> = { workspace: 'workspace', 'bind-store': 'connect_store', 'choose-product': 'select_product', 'add-assets': 'add_assets', 'start-content': 'generate_review', publish: 'publish' }
    const toState = (state: string) => state === 'next' ? 'required' : state
    const steps = onboarding.steps.map(step => ({ id: stepId[step.id] ?? step.id, title: step.title, state: toState(step.state), summary: step.summary, entry_method: step.entryMethod, primary_action: onboardingPrimaryAction(step) }))
    const current = onboarding.steps.find(step => step.id === onboarding.currentStep.id) ?? onboarding.steps[0]!
    return {
      schema_version: '2',
      source: 'server',
      side_effects: sideEffects,
      current_step: { id: stepId[current.id] ?? current.id, title: current.title, state: toState(current.state), summary: current.summary, primary_action: onboardingPrimaryAction(current) },
      steps,
    }
  }

  function merchantCapabilityCardAction(card: { id: string; entryMethod: string }, onboarding: ReturnType<typeof workspaceOnboarding>, directory: ReturnType<typeof workspaceStoreDirectory>) {
    const { summary } = onboarding
    if (card.id === 'first-value') return { method: 'merchant.first_value', arguments: { example: 'true' }, required_inputs: [], reason: '先查看安全示例预览；如需真实商品，请先选择 platform + account_id + product_id', blocked_by: [] as string[] }
    if (card.id === 'stores-products') {
      const realStoreCount = directory.filter(store => store.dataMode === 'official_api' && store.readable).length
      if (!realStoreCount) return { method: 'platform.connect', arguments: {}, required_inputs: ['platform'], reason: directory.length ? '当前只有演示店铺，正式商品任务需要先连接真实店铺' : '先绑定一个平台店铺', blocked_by: [] as string[] }
      return { method: 'catalog.search', arguments: { scope: 'store' }, required_inputs: ['platform', 'account_id'], reason: '先选择具体平台和店铺，再查看商品', blocked_by: summary.products ? [] : ['product_sync_or_import'] }
    }
    if (card.id === 'knowledge-assets') {
      return { method: 'asset.list', arguments: {}, required_inputs: [], reason: summary.products ? '查看素材状态；没有素材时再上传商品图片或品牌资料' : '先选择店铺商品', blocked_by: summary.products ? [] : ['store_product_selection'] }
    }
    if (card.id === 'content') {
      if (!summary.products) return { method: 'catalog.search', arguments: { scope: 'store' }, required_inputs: ['platform', 'account_id'], reason: '先选择商品', blocked_by: ['store_product_selection'] }
      return { method: 'task.understand', arguments: {}, required_inputs: ['instruction', 'platform', 'account_id'], reason: summary.confirmedProducts ? '输入一句营销目标，开始创建内容任务' : '先确认商品、价格、库存和图片事实', blocked_by: summary.confirmedProducts ? [] : ['product_facts_confirmation'] }
    }
    if (card.id === 'visuals') {
      if (!summary.products) return { method: 'asset.upload', arguments: {}, required_inputs: ['name', 'mime_type', 'file_path'], reason: '可直接上传商品图片生成未绑定候选图；结果仅供审阅，不可发布', blocked_by: [] as string[] }
      return { method: 'catalog.image.generate', arguments: {}, required_inputs: ['product_id'], reason: '使用已确认商品和素材生成图片候选；结果仍需审核', blocked_by: [] as string[] }
    }
    if (card.id === 'review-publish') return { method: summary.tasks ? 'publish.prepare' : 'task.history', arguments: {}, required_inputs: summary.tasks ? ['task_id'] : [], reason: summary.tasks ? '先查看发布前检查和店铺范围' : '先创建内容任务', blocked_by: summary.tasks ? [] : ['content_task'] }
    if (card.id === 'bulk-publish') return { method: 'publish.batch.prepare', arguments: {}, required_inputs: ['task_ids_json'], reason: '批量发布前逐项预检和确认；每个任务仍需独立确认哈希', blocked_by: summary.tasks ? [] : ['content_task'] }
    if (card.id === 'rules') return { method: 'rule.sync.status', arguments: {}, required_inputs: [], reason: '先查看六个平台规则是否新鲜，再按店铺平台查看适用规则；生成和审核会自动执行同一平台预检', blocked_by: [] as string[] }
    return { method: card.entryMethod, arguments: {}, required_inputs: [], reason: '查看套餐、模型成本和充值到账状态', blocked_by: [] as string[] }
  }

  return { fixturePlatformEnabled, manualPlatformEnabled, platformConnectorConfigured, platformAuthorizationConfigured, fixtureAccountId, defaultFixtureAccountId, connectedPlatformAccountId, requireActivePlatformAccount, resolveTaskAccountId, resolveProductTaskAccount, requireProductionTaskStore, requireProductionRequestStores, platformAccessFlags, platformWriteReady, workspaceConnectorReadiness, workspacePlatformStatus, publicAuthorization, workspaceStoreDirectory, platformAccountAccessItems, merchantPlatformOptions, workspaceOnboarding, onboardingPrimaryAction, merchantOnboardingProjection, merchantCapabilityCardAction }
}
