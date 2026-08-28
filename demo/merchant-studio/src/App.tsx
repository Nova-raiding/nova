import { useEffect, useMemo, useRef, useState } from 'react'
import './capability.css'
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileCheck2,
  FileText,
  Gauge,
  History,
  LayoutDashboard,
  Link2,
  Menu,
  PackageSearch,
  PanelLeftClose,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import { answerTask, approveContent, authorizePlatform, completeFixtureAuthorization, confirmAssetFacts, confirmPublish, confirmTaskPlan, createRechargeOrder, createTask, createTaskGroup, decideReviewFinding, describeApiError, diffContentVersions, extractBrandProfile, fetchApiHealth, fetchAssetBlob, fetchAssets, fetchBillingStatus, fetchBrandProfile, fetchCatalogCategories, fetchContentVersions, fetchPlatformAccounts, fetchPlatformCapabilities, fetchProducts, fetchPublishJobs, fetchRulePacks, fetchRechargeOrder, fetchSyncJobs, fetchTask, fetchTaskFeedback, fetchTaskTimeline, fetchTasks, fetchWorkspaceMetrics, generateContent, importProduct, isNotConfigured, modifyContentVersion, parseAsset, preparePublish, reviewContent, reviewProductImages, retrySyncFailures, revokePlatform, saveAssetPreference, saveBrandProfile, selectDirection, submitTaskFeedback, syncPlatform, understandTask, updateAssetRights, uploadAsset, type AssetMetadata, type BrandCandidateFieldKey, type BrandExtraction, type BrandProfile, type BrandVisualRules, type BillingStatus, type CatalogCategory, type FeedbackRating, type Product as ApiProduct, type ContentVersion, type PlatformAccount, type PlatformCapability, type PlatformId, type PublishJob, type PublishPreview, type RechargeOrder, type ReviewCategory, type ReviewFinding, type RulePack, type SyncJob, type Task, type TaskFeedback, type TaskQuestion, type TaskTimelineEvent, type TaskUnderstanding, type WorkspaceMetrics } from './api'
import { resolveStoreSyncTargets } from './store-sync'
import { storeIdentityLabel, validateProductStoreIdentity, validateTargetStoreIdentity, validateTaskStoreIdentity } from './store-identity'

type Page = 'overview' | 'products' | 'task' | 'publish' | 'rules'
type Platform = '京东' | '淘宝' | '天猫' | '拼多多' | '小红书' | '抖音'

const navItems: Array<{ id: Page; label: string; icon: typeof LayoutDashboard; badge?: string }> = [
  { id: 'overview', label: '运营概览', icon: LayoutDashboard },
  { id: 'products', label: '商品与资产', icon: Boxes },
  { id: 'task', label: '营销任务', icon: Sparkles },
  { id: 'publish', label: '发布中心', icon: Rocket },
  { id: 'rules', label: '规则与检查', icon: ShieldCheck },
]

const platforms: Array<{ name: Platform; platformId: PlatformId; shop: string; status: string; tone: string; sync: string; canSync: boolean }> = [
  { name: '京东', platformId: 'jd', shop: '云朵轻户外旗舰店', status: '演示已连接', tone: 'red', sync: '演示数据', canSync: true },
  { name: '淘宝', platformId: 'taobao', shop: '云朵轻户外', status: '演示已连接', tone: 'orange', sync: '演示数据', canSync: true },
  { name: '天猫', platformId: 'tmall', shop: '云朵轻户外旗舰店', status: '需授权', tone: 'orange', sync: '尚未同步', canSync: false },
  { name: '拼多多', platformId: 'pinduoduo', shop: '云朵户外专营店', status: '需重新授权', tone: 'yellow', sync: '2 天前', canSync: false },
  { name: '小红书', platformId: 'xiaohongshu', shop: '云朵轻户外生活方式店', status: '演示待授权', tone: 'red', sync: '尚未同步', canSync: false },
  { name: '抖音', platformId: 'douyin', shop: '云朵轻户外旗舰店', status: '演示待授权', tone: 'orange', sync: '尚未同步', canSync: false },
]

const platformNames: Record<string, Platform> = { jd: '京东', taobao: '淘宝', tmall: '天猫', pinduoduo: '拼多多', xiaohongshu: '小红书', douyin: '抖音' }
const platformTone: Record<string, string> = { jd: 'red', taobao: 'orange', tmall: 'orange', pinduoduo: 'yellow', xiaohongshu: 'red', douyin: 'orange' }

function ErrorNotice({ message, onRetry, compact = false }: { message: string; onRetry?: () => void; compact?: boolean }) {
  return <div className={`inline-error ${compact ? 'compact' : ''}`} role="alert"><AlertCircle size={16} /><span>{message}</span>{onRetry && <button className="text-button" onClick={onRetry}>重试</button>}</div>
}

function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return <div className="loading-state" role="status" aria-live="polite"><RefreshCw className="spin" size={16} />{label}</div>
}

const products = [
  { name: '轻云防晒外套 2026', sku: '8 SKU', platform: '淘宝', source: '演示数据', status: '事实已确认', stock: 1286, issue: 0 },
  { name: '山系多袋冲锋衣', sku: '12 SKU', platform: '京东', source: '演示数据', status: '待确认 3 项', stock: 642, issue: 3 },
  { name: '云感速干阔腿裤', sku: '6 SKU', platform: '拼多多', source: '演示数据', status: '同步已过期', stock: 388, issue: 2 },
  { name: '城市轻徒步鞋', sku: '10 SKU', platform: '淘宝', source: '演示数据', status: '事实已确认', stock: 907, issue: 0 },
  { name: '山野生活方式衬衫', sku: '5 SKU', platform: '小红书', source: '演示数据', status: '待确认 2 项', stock: 264, issue: 2 },
  { name: '轻户外机能马甲', sku: '7 SKU', platform: '抖音', source: '演示数据', status: '待确认 1 项', stock: 518, issue: 1 },
]

const activity = [
  ['演示发布状态', '轻云防晒外套 · 淘宝', '演示数据'],
  ['演示规则检查', '山系多袋冲锋衣 · 发现 3 项', '演示数据'],
  ['演示商品同步', '京东 · 更新 24 件商品', '演示数据'],
  ['演示版本状态', '轻云防晒外套 · 内容 v4', '演示数据'],
]

function BrandMark() {
  return <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
}

function StatusChip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`status-chip ${tone}`}>{children}</span>
}

function reviewFieldLabel(field: string) {
  if (field === 'content') return '文案内容'
  if (field === 'facts') return '商品事实'
  if (field === 'rules') return '平台规则'
  if (field === 'sku') return 'SKU 信息'
  if (field === 'price') return '商品价格'
  if (field.startsWith('images[')) return '商品图片'
  if (field.startsWith('modules.')) return '详情模块'
  if (field.startsWith('visualRules.logo')) return '品牌 Logo 规则'
  if (field.startsWith('visualRules.fonts')) return '品牌字体授权'
  return '待检查内容'
}

function platformFieldLabel(path: string) {
  const key = path.toLowerCase().replace(/^fields\./u, '')
  if (['title', 'name', 'goods_name'].includes(key)) return '商品标题'
  if (['description', 'detail', 'desc', 'goods_desc'].includes(key)) return '商品详情'
  if (['images', 'main_image', 'image_url'].some(field => key.includes(field))) return '商品图片'
  if (key.includes('category') || key === 'cid' || key === 'cat_id') return '商品类目'
  if (key.includes('price')) return '商品价格'
  if (key.includes('stock') || key.includes('quantity')) return '商品库存'
  if (key.includes('sku')) return 'SKU 信息'
  return `平台字段（${path}）`
}

function reviewEvidenceLabel(finding: ReviewFinding) {
  if (finding.evidence?.kind !== 'brand') return undefined
  const revision = finding.evidence.sourceIds[0]?.match(/:r(\d+)$/u)?.[1]
  return `依据：任务确认时冻结的品牌档案${revision ? ` · 版本 r${revision}` : ''}`
}

type UtilityPanel = 'health' | 'help' | 'settings'

function Topbar({ page, openMenu, apiOnline, onOpenUtility, searchQuery, onSearchQuery, onSearch }: { page: Page; openMenu: () => void; apiOnline: boolean | null; onOpenUtility: (panel: UtilityPanel) => void; searchQuery: string; onSearchQuery: (value: string) => void; onSearch: () => void }) {
  const titles: Record<Page, string> = {
    overview: '运营概览', products: '商品与资产', task: '营销任务', publish: '发布中心', rules: '规则与检查',
  }
  return (
    <header className="topbar">
      <button className="icon-button mobile-menu" onClick={openMenu} aria-label="打开主菜单"><Menu size={20} /></button>
      <div>
        <div className="eyebrow">云朵轻户外 · 生产工作区</div>
        <h1>{titles[page]}</h1>
      </div>
      <div className="topbar-actions">
        <label className="search-box">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">全局搜索</span>
          <input value={searchQuery} onChange={event => onSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') onSearch() }} placeholder="搜索商品" aria-label="搜索商品" />
          <kbd>⌘ K</kbd>
        </label>
        <button className="health-button" onClick={() => onOpenUtility('health')} aria-label="查看系统健康"><span className={`pulse-dot ${apiOnline === false ? 'offline' : ''}`} />系统健康 <b>{apiOnline === false ? '离线' : apiOnline === true ? '在线' : '未读取'}</b></button>
        <button className="avatar-button" onClick={() => onOpenUtility('settings')} aria-label="账户菜单">林</button>
      </div>
    </header>
  )
}

function Sidebar({ page, setPage, open, close, onOpenUtility }: { page: Page; setPage: (page: Page) => void; open: boolean; close: () => void; onOpenUtility: (panel: UtilityPanel) => void }) {
  return (
    <>
      {open && <button className="sidebar-backdrop" onClick={close} aria-label="关闭主菜单" />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><BrandMark /><div><strong>Merchant Studio</strong><span>商家营销助手</span></div></div>
        <nav aria-label="主导航">
          <div className="nav-label">工作台</div>
          {navItems.map(item => {
            const Icon = item.icon
            return (
              <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => { setPage(item.id); close() }} aria-current={page === item.id ? 'page' : undefined}>
                <Icon size={19} /><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => onOpenUtility('help')}><CircleHelp size={19} /><span>帮助与诊断</span></button>
          <button onClick={() => onOpenUtility('settings')}><Settings size={19} /><span>工作区设置</span></button>
          <div className="capacity-card">
            <div><span>工作区容量</span><b>实时读取</b></div>
            <div className="capacity-track" aria-hidden="true" />
            <small>由当前套餐与云端配置决定，请在账务入口查看</small>
          </div>
        </div>
      </aside>
    </>
  )
}

function UtilityPanel({ panel, apiOnline, apiBaseUrl, onClose }: { panel: UtilityPanel; apiOnline: boolean | null; apiBaseUrl?: string; onClose: () => void }) {
  const content = panel === 'help'
    ? { icon: CircleHelp, kicker: 'HELP & DIAGNOSTICS', title: '如何使用 Merchant Studio', body: '先在商品与资产中确认平台商品，再创建营销任务。完成事实确认、方向选择、内容审核后，才能进入发布确认。', items: ['商品与资产：绑定平台店铺、同步商品和管理素材', '营销任务：确认事实、生成文案、查看规则和版本记录', '发布中心：只展示已审核任务，并在提交前再次确认'] }
    : panel === 'settings'
      ? { icon: Settings, kicker: 'WORKSPACE SETTINGS', title: '工作区设置', body: '当前页面展示本地工作区的连接信息；真实凭证、模型中转站和生产权限由服务端配置管理。', items: [`工作区：${import.meta.env.VITE_WORKSPACE_ID ?? 'ws_demo'}`, `API 地址：${apiBaseUrl ?? '未配置（离线演示）'}`, '数据范围：当前工作区隔离；不会跨店铺复用商品事实'] }
      : { icon: Gauge, kicker: 'SYSTEM HEALTH', title: '系统健康', body: apiOnline === true ? '已成功读取 API 健康检查。下面的状态只代表当前页面到 API 的连通性。' : apiOnline === false ? '当前页面无法读取 API。商品同步、生成和发布不会在离线状态下伪造成功。' : '尚未执行 API 健康检查。', items: [`API 连通：${apiOnline === true ? '正常' : apiOnline === false ? '失败' : '未读取'}`, `API 地址：${apiBaseUrl ?? '未配置'}`, '外部平台、模型和支付 provider 仍需在部署环境单独验收'] }
  const Icon = content.icon
  return <div className="modal-layer" role="presentation"><div className="modal utility-modal" role="dialog" aria-modal="true" aria-labelledby="utility-panel-title"><div className="modal-head"><div className="modal-icon"><Icon size={20} /></div><div><span className="section-kicker">{content.kicker}</span><h2 id="utility-panel-title">{content.title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭面板"><X size={19} /></button></div><div className="modal-body"><p className="utility-body">{content.body}</p><div className="utility-list">{content.items.map(item => <div key={item}><CheckCircle2 size={15} /><span>{item}</span></div>)}</div></div><div className="modal-actions"><button className="primary" onClick={onClose}>知道了</button></div></div></div>
}

function MetricCard({ icon: Icon, label, value, detail, tone }: { icon: typeof Gauge; label: string; value: string; detail: string; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>
}

function Overview({ goTask, goProducts, goTasks, baseUrl, onOpenUtility }: { goTask: () => void; goProducts: () => void; goTasks: () => void; baseUrl?: string; onOpenUtility: (panel: UtilityPanel) => void }) {
  const accountsRequestId = useRef(0)
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null)
  const [capabilities, setCapabilities] = useState<PlatformCapability[] | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(Boolean(baseUrl))
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(Boolean(baseUrl))
  const [accountsError, setAccountsError] = useState('')
  const [capabilitiesError, setCapabilitiesError] = useState('')
  const [action, setAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [syncJobs, setSyncJobs] = useState<SyncJob[] | null>(null)
  const [syncJobsError, setSyncJobsError] = useState('')
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingError, setBillingError] = useState('')
  const [rechargeOrder, setRechargeOrder] = useState<RechargeOrder | null>(null)
  const [rechargeQuerying, setRechargeQuerying] = useState(false)
  const [metrics, setMetrics] = useState<WorkspaceMetrics | null>(null)
  const [metricsError, setMetricsError] = useState('')
  const loadAccounts = () => {
    if (!baseUrl) return
    const requestId = ++accountsRequestId.current
    setAccountsLoading(true); setAccountsError(''); setAccounts(null)
    fetchPlatformAccounts(baseUrl)
      .then(result => { if (requestId === accountsRequestId.current) setAccounts(result.items) })
      .catch(error => { if (requestId === accountsRequestId.current) { setAccounts(null); setAccountsError(`店铺发现失败：${describeApiError(error)}。为避免同步到错误店铺，已停止全部同步。`) } })
      .finally(() => { if (requestId === accountsRequestId.current) setAccountsLoading(false) })
  }
  useEffect(() => { loadAccounts() }, [baseUrl])
  const loadCapabilities = () => {
    if (!baseUrl) return
    setCapabilitiesLoading(true); setCapabilitiesError('')
    fetchPlatformCapabilities(baseUrl).then(result => setCapabilities(result.items)).catch(error => setCapabilitiesError(describeApiError(error))).finally(() => setCapabilitiesLoading(false))
  }
  useEffect(() => { loadCapabilities() }, [baseUrl])
  const loadSyncJobs = () => {
    if (!baseUrl) return
    setSyncJobsError('')
    fetchSyncJobs(baseUrl).then(setSyncJobs).catch(error => setSyncJobsError(describeApiError(error)))
  }
  useEffect(() => { loadSyncJobs() }, [baseUrl])
  const loadBilling = () => {
    if (!baseUrl) return
    setBillingError('')
    fetchBillingStatus(baseUrl).then(setBilling).catch(error => setBillingError(describeApiError(error)))
  }
  useEffect(() => { loadBilling() }, [baseUrl])
  const loadMetrics = () => {
    if (!baseUrl) return
    setMetricsError('')
    fetchWorkspaceMetrics(baseUrl).then(setMetrics).catch(error => setMetricsError(describeApiError(error)))
  }
  useEffect(() => { loadMetrics() }, [baseUrl])
  const recharge = async () => {
    if (!baseUrl) return
    const amount = window.prompt('请输入充值金额（元）', '100')?.trim()
    if (!amount) return
    try {
      const order = await createRechargeOrder(baseUrl, amount)
      setRechargeOrder({ ...order, amount_cny: order.amount_cny ?? amount })
      if (order.payment_url?.startsWith('http')) window.open(order.payment_url, '_blank', 'noopener,noreferrer')
      loadBilling()
    } catch (error) { setBillingError(describeApiError(error)) }
  }
  const queryRechargeOrder = async () => {
    if (!baseUrl || !rechargeOrder) return
    setRechargeQuerying(true); setBillingError('')
    try {
      const order = await fetchRechargeOrder(baseUrl, rechargeOrder.id)
      setRechargeOrder({ ...rechargeOrder, ...order })
      loadBilling()
    } catch (error) { setBillingError(describeApiError(error)) } finally { setRechargeQuerying(false) }
  }
  const retryFailures = (job: SyncJob) => {
    if (!baseUrl || !job.failedItems.length) return
    setAction(`retry-${job.id}`); setActionError('')
    retrySyncFailures(baseUrl, job.id, job.failedItems.filter(item => item.retryable).map(item => item.id)).then(loadSyncJobs).catch(error => setActionError(`同步失败重试：${describeApiError(error)}`)).finally(() => setAction(null))
  }
  const connect = (platform: PlatformId) => {
    if (!baseUrl) return
    setAction(platform); setActionError(''); setActionMessage('')
    authorizePlatform(baseUrl, platform).then(result => {
      if (result.mode === 'fixture') {
        return completeFixtureAuthorization(baseUrl, platform, result.authorizationUrl).then(() => { setActionMessage(`${platformNames[platform]} 已完成演示授权，首轮同步已排队。`); loadAccounts() })
      }
      if (result.authorizationUrl) window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
      loadAccounts()
      let attempts = 0
      const timer = window.setInterval(() => { attempts += 1; loadAccounts(); if (attempts >= 10) window.clearInterval(timer) }, 2000)
    }).catch(error => setActionError(`${platform}：${describeApiError(error)}`)).finally(() => setAction(null))
  }
  const sync = (platform: PlatformId, accountId?: string) => {
    if (!baseUrl) return
    if (!accountId) { setActionError(`${platformNames[platform]}店铺缺少稳定的店铺 ID，未发起同步。`); return }
    setAction(`sync-${platform}`); setActionError(''); setActionMessage('')
    syncPlatform(baseUrl, platform, accountId).then(() => setActionError('')).catch(error => setActionError(`${platformNames[platform]}：${describeApiError(error)}`)).finally(() => setAction(null))
  }
  const syncAll = async () => {
    if (!baseUrl) return
    const resolution = resolveStoreSyncTargets(accounts)
    if (!resolution.ok) { setActionError(resolution.message); return }
    setAction('sync-all'); setActionError(''); setActionMessage('')
    try {
      const results = await Promise.allSettled(resolution.targets.map(target => syncPlatform(baseUrl, target.platform, target.accountId)))
      const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${platformNames[resolution.targets[index].platform]} · ${resolution.targets[index].label}：${describeApiError(result.reason)}`] : [])
      if (failures.length) setActionError(`部分店铺同步失败；未自动改选其他店铺。${failures.join('；')}`)
      else setActionMessage(`已为 ${resolution.targets.length} 家店铺逐店发起同步。`)
    } finally { setAction(null) }
  }
  const revoke = (platform: PlatformId, accountId?: string) => {
    if (!baseUrl || !accountId || !window.confirm('撤销后将立即停止同步和发布，但会保留已有商品快照与审计记录。确定撤销吗？')) return
    setAction(`revoke-${platform}`); setActionError(''); setActionMessage('')
    revokePlatform(baseUrl, platform, accountId).then(() => loadAccounts()).catch(error => setActionError(`${platformNames[platform]}：${describeApiError(error)}`)).finally(() => setAction(null))
  }
  const apiRows = accounts?.map(account => ({ name: platformNames[account.platform] ?? account.platform, platformId: account.platform, accountId: account.accountId, shop: account.label ?? account.alias ?? account.storeName ?? (account.accountId ? `店铺（${account.accountId}）` : '尚未绑定店铺'), status: account.state === 'fixture_ready' ? '已连接（演示）' : account.state === 'connected' ? '已连接' : account.state === 'revoked' ? '需重新授权' : '未配置', tone: account.state === 'not_configured' || account.state === 'revoked' ? 'amber' : 'green', sync: account.readEnabled ? '可同步' : '需授权', canSync: account.readEnabled }))
  const rows = apiRows ?? (baseUrl ? [] : platforms.map(platform => ({ ...platform, platform: platform.name, accountId: undefined })))
  const connectedStoreCount = metrics ? metrics.stores.filter(store => store.connection?.readable).length : platforms.filter(platform => platform.status === '演示已连接').length
  const approvedCount = metrics ? (metrics.taskFunnel.approved ?? 0) + (metrics.taskFunnel.delivered ?? 0) : 18
  const riskCount = metrics?.riskSummary.total ?? 5
  const highRiskCount = metrics ? metrics.riskItems.filter(item => item.severity === 'high').length : 2
  const capabilityStateLabel = (state: string) => ({ unverified: '未验证', documented: '已记录', fixture_verified: '演示通过', test_e2e: 'E2E 通过', production_canary: '生产 canary' }[state] ?? state)
  const capabilityTone = (state: string) => state === 'production_canary' || state === 'test_e2e' ? 'green' : state === 'unverified' ? 'amber' : 'blue'
  return (
    <div className="page-stack">
      <section className="welcome-panel">
        <div>
          <StatusChip tone="green"><Zap size={13} /> 今日工作流正常</StatusChip>
          <h2>把商品事实变成<br />可放心发布的内容</h2>
          <p>同步商品、确认事实、生成营销内容，并在发布前看清每一处变化。</p>
          <div className="button-row"><button className="primary" onClick={goTask}><Sparkles size={17} />创建营销任务</button><button className="secondary" onClick={() => void syncAll()} disabled={!baseUrl || accountsLoading || Boolean(accountsError) || accounts === null || Boolean(action)}><RefreshCw size={17} className={action?.startsWith('sync-') || accountsLoading ? 'spin' : undefined} />{action?.startsWith('sync-') ? '同步中…' : accountsLoading ? '正在发现店铺…' : '同步全部店铺'}</button></div>
        </div>
        <div className="flow-preview" aria-label="当前任务流程">
          <div className="flow-orbit"><span className="orbit-dot one" /><span className="orbit-dot two" /><div className="flow-center"><Sparkles size={25} /><b>AI</b></div></div>
          <div className="flow-caption"><span className="done"><Check size={14} />事实确认</span><span className="active">内容生成</span><span>检查发布</span></div>
        </div>
      </section>

      <section className="metric-grid" aria-label="关键运营指标">
        <MetricCard icon={Store} label="已连接店铺" value={String(connectedStoreCount)} detail={metrics ? `${metrics.stores.length - connectedStoreCount} 家需处理或未就绪` : '演示数据'} tone="green" />
        <MetricCard icon={FileCheck2} label="已批准内容" value={String(approvedCount)} detail={metrics ? '当前工作区累计' : '演示数据'} tone="blue" />
        <MetricCard icon={Clock3} label="平均首稿耗时" value="—" detail="当前接口暂无耗时统计" tone="violet" />
        <MetricCard icon={AlertCircle} label="需处理问题" value={String(riskCount)} detail={`其中 ${highRiskCount} 项高风险`} tone="amber" />
      </section>

      {metricsError && <ErrorNotice message={`运营指标：${metricsError}`} onRetry={loadMetrics} compact />}

      {baseUrl && <section className="panel wallet-panel">
        <div className="panel-heading"><div><span className="section-kicker">PLUGIN WALLET</span><h3>插件钱包与能力解锁</h3></div><StatusChip tone={billing?.plugin_access.unlocked ? 'green' : 'amber'}>{billing?.plugin_access.unlocked ? '已解锁' : '充值后解锁'}</StatusChip></div>
        {billingError && <ErrorNotice message={billingError} onRetry={loadBilling} compact />}
        <div className="wallet-content"><div><strong className="wallet-balance">¥{billing?.balance_cny ?? '—'}</strong><p>{billing?.model_access.message ?? '正在读取钱包状态…'}</p><small>充值后开放内容、图片、视频生成及发布确认；店铺和商品查看不受影响。</small></div><button className="primary" onClick={recharge}>充值并解锁</button></div>
        {rechargeOrder && <div className="recharge-order-card" role="status"><div className="recharge-order-head"><div><span className="section-kicker">RECHARGE ORDER</span><b>充值订单</b></div><StatusChip tone={rechargeOrder.state === 'paid' ? 'green' : 'amber'}>{rechargeOrder.state === 'paid' ? '已到账' : rechargeOrder.state === 'pending' ? '待支付 / 待回调' : rechargeOrder.state}</StatusChip></div><div className="recharge-order-meta"><span>订单号 <b>{rechargeOrder.id}</b></span><span>金额 <b>¥{rechargeOrder.amount_cny ?? '—'}</b></span><span>渠道 <b>{rechargeOrder.channel === 'wechat' ? '微信支付' : '支付宝'}</b></span></div>{rechargeOrder.payment_mode === 'fixture' || rechargeOrder.paymentMode === 'fixture' || rechargeOrder.payment_url?.startsWith('fixture:') || rechargeOrder.paymentUrl?.startsWith('fixture:') ? <p className="recharge-mock-note">当前为 Mock 演示订单，不会产生真实扣款。点击“查询订单”可验证订单状态。</p> : rechargeOrder.warning && <p className="recharge-mock-note">{rechargeOrder.warning}</p>}<div className="button-row"><button className="secondary" onClick={queryRechargeOrder} disabled={rechargeQuerying}>{rechargeQuerying ? '查询中…' : '查询订单'}</button>{(rechargeOrder.payment_url?.startsWith('http') || rechargeOrder.paymentUrl?.startsWith('http')) && <button className="text-button" onClick={() => window.open(rechargeOrder.payment_url ?? rechargeOrder.paymentUrl, '_blank', 'noopener,noreferrer')}>打开支付页面 <ArrowRight size={14} /></button>}</div></div>}
      </section>}

      <section className="dashboard-grid">
        <article className="panel platform-panel" aria-busy={accountsLoading}>
          <div className="panel-heading"><div><span className="section-kicker">CONNECTIONS</span><h3>平台连接</h3></div><button className="text-button" onClick={goProducts}>管理连接 <ArrowRight size={15} /></button></div>
          {accountsLoading && <LoadingState label="正在读取平台连接…" />}
          {accountsError && <ErrorNotice message={accountsError} onRetry={loadAccounts} compact />}
          {actionError && <ErrorNotice message={actionError} compact />}
          {actionMessage && <div className="info-notice" role="status"><CheckCircle2 size={15} />{actionMessage}</div>}
          <div className="platform-list">
            {rows.map((platform) => <div className="platform-row" key={`${platform.platformId}-${platform.accountId ?? 'unbound'}`}><div className={`platform-logo ${platform.tone}`}>{platform.name.slice(0, 1)}</div><div className="platform-meta"><b>{platform.name}</b><span>{platform.shop}</span></div><div className="platform-sync"><StatusChip tone={platform.tone === 'green' ? 'green' : 'amber'}>{platform.status}</StatusChip><small>{platform.sync}</small></div>{baseUrl ? <>{platform.canSync && <button className="text-button" onClick={() => sync(platform.platformId, platform.accountId)} disabled={Boolean(action)}>{action === `sync-${platform.platformId}` ? '同步中…' : '同步'}</button>}{platform.accountId && platform.status === '已连接' && <button className="text-button danger" onClick={() => revoke(platform.platformId, platform.accountId)} disabled={Boolean(action)}>{action === `revoke-${platform.platformId}` ? '撤销中…' : '撤销'}</button>}{!platform.canSync && (!platform.accountId || platform.status === '需重新授权') && <button className="text-button" onClick={() => connect(platform.platformId)} disabled={Boolean(action)}>{action === platform.platformId ? '处理中…' : platform.status === '需重新授权' ? '重新授权' : '连接'}</button>}</> : <button className="icon-button" onClick={() => onOpenUtility('help')} aria-label={`查看${platform.name}连接详情`}><ChevronDown size={17} /></button>}</div>)}
          </div>
        </article>
        <article className="panel activity-panel">
          <div className="panel-heading"><div><span className="section-kicker">RECENT</span><h3>最近动态</h3></div><button className="text-button" onClick={goTasks}>查看全部</button></div>
          <div className="activity-list">
            {activity.map(([title, detail, time], index) => <div className="activity-row" key={title}><span className={`activity-symbol a${index}`}><Check size={14} /></span><div><b>{title}</b><span>{detail}</span></div><time>{time}</time></div>)}
          </div>
        </article>
      </section>
      {baseUrl && <section className="panel sync-failures-panel">
        <div className="panel-heading"><div><span className="section-kicker">SYNC RECOVERY</span><h3>同步任务与失败项</h3></div><button className="text-button" onClick={loadSyncJobs}><RefreshCw size={14} />刷新</button></div>
        {syncJobsError && <ErrorNotice message={syncJobsError} onRetry={loadSyncJobs} compact />}
        {!syncJobsError && syncJobs?.length === 0 && <div className="empty-state"><CheckCircle2 size={18} />暂无同步任务</div>}
        {syncJobs?.filter(job => job.itemsFailed > 0).map(job => <div className="sync-failure-row" key={job.id}><div><b>{platformNames[job.platform] ?? job.platform} · {job.id}</b><span>{job.itemsFailed} 项失败 · {job.failedItems[0]?.message ?? '请查看失败详情'}</span></div><StatusChip tone="amber">{job.state}</StatusChip><button className="text-button" onClick={() => retryFailures(job)} disabled={Boolean(action) || !job.failedItems.some(item => item.retryable)}>{action === `retry-${job.id}` ? '重试中…' : '重试失败项'}</button></div>)}
        {syncJobs && syncJobs.length > 0 && syncJobs.every(job => job.itemsFailed === 0) && <div className="empty-state"><CheckCircle2 size={18} />当前同步任务没有失败项</div>}
      </section>}
      <section className="panel capability-panel" aria-busy={capabilitiesLoading}>
        <div className="panel-heading"><div><span className="section-kicker">CAPABILITY EVIDENCE</span><h3>平台能力证据</h3></div><button className="text-button" onClick={loadCapabilities} disabled={capabilitiesLoading}><RefreshCw size={14} className={capabilitiesLoading ? 'spin' : undefined} />刷新证据</button></div>
        {capabilitiesLoading && <LoadingState label="正在读取平台能力证据…" />}
        {capabilitiesError && <ErrorNotice message={capabilitiesError} onRetry={loadCapabilities} compact />}
        {!capabilitiesLoading && !capabilitiesError && capabilities && <div className="capability-grid">{capabilities.map(item => {
          const canaryCount = item.capabilities.filter(capability => capability.state === 'production_canary').length
          return <article className="capability-card" key={item.platform}><div className="capability-card-head"><div className={`platform-logo ${platformTone[item.platform] ?? 'blue'}`}>{(platformNames[item.platform] ?? item.platform).slice(0, 1)}</div><div><b>{platformNames[item.platform] ?? item.platform}</b><span>{item.readiness.ready ? '连接器已就绪' : item.readiness.reasons[0] ?? '等待证据'}</span></div><StatusChip tone={canaryCount === item.capabilities.length ? 'green' : 'amber'}>{canaryCount}/{item.capabilities.length} canary</StatusChip></div><div className="capability-list">{item.capabilities.map(capability => <span className={`capability-pill ${capabilityTone(capability.state)}`} key={capability.capability} title={capability.evidenceRef ? `证据：${capability.evidenceRef}` : '尚无证据引用'}>{capability.capability}<small>{capabilityStateLabel(capability.state)}</small></span>)}</div></article>
        })}</div>}
        {!baseUrl && <div className="info-notice capability-note"><CircleHelp size={15} />离线演示不读取真实能力证据；正式上线必须由 API 返回并绑定证据引用。</div>}
      </section>
    </div>
  )
}

const platformLabel: Record<string, string> = { jd: '京东', taobao: '淘宝', tmall: '天猫', pinduoduo: '拼多多', xiaohongshu: '小红书', douyin: '抖音' }

type Target = { productId: string; platform: PlatformId; title: string; remoteId?: string; accountId?: string; storeName?: string; taskId?: string }

function AssetLibrary({ baseUrl }: { baseUrl?: string }) {
  const [assets, setAssets] = useState<AssetMetadata[] | null>(null)
  const [assetPreviews, setAssetPreviews] = useState<Record<string, string>>({})
  const [assetStorageReady, setAssetStorageReady] = useState(false)
  const [brand, setBrand] = useState<BrandProfile | null>(null)
  const [extraction, setExtraction] = useState<BrandExtraction | null>(null)
  const [selectedBrandFields, setSelectedBrandFields] = useState<BrandCandidateFieldKey[]>([])
  const [selectedAlternatives, setSelectedAlternatives] = useState<Partial<Record<BrandCandidateFieldKey, number>>>({})
  const [brandAction, setBrandAction] = useState('')
  const [brandMessage, setBrandMessage] = useState('')
  const [preferenceAssetId, setPreferenceAssetId] = useState('')
  const [preferenceVerdict, setPreferenceVerdict] = useState<'excellent' | 'disliked'>('excellent')
  const [preferenceReasons, setPreferenceReasons] = useState('')
  const [preferenceNote, setPreferenceNote] = useState('')
  const [preferenceAction, setPreferenceAction] = useState('')
  const [assetAction, setAssetAction] = useState('')
  const [visualPanelOpen, setVisualPanelOpen] = useState(false)
  const [visualLogoIds, setVisualLogoIds] = useState<string[]>([])
  const [visualPrimary, setVisualPrimary] = useState('')
  const [visualSecondary, setVisualSecondary] = useState('')
  const [visualForbidden, setVisualForbidden] = useState('')
  const [visualFonts, setVisualFonts] = useState('')
  const [visualFontLicense, setVisualFontLicense] = useState<'approved' | 'restricted' | 'unknown'>('unknown')
  const [visualStyles, setVisualStyles] = useState('')
  const [restrictedPeople, setRestrictedPeople] = useState('')
  const [restrictedSpokespersons, setRestrictedSpokespersons] = useState('')
  const [restrictedIps, setRestrictedIps] = useState('')
  const [restrictedContent, setRestrictedContent] = useState('')
  const [logoRecolor, setLogoRecolor] = useState(false)
  const [logoDistortion, setLogoDistortion] = useState(false)
  const [logoRedraw, setLogoRedraw] = useState(false)
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [error, setError] = useState('')
  const uploadInput = useRef<HTMLInputElement>(null)
  const [uploadAction, setUploadAction] = useState('')
  const load = () => {
    if (!baseUrl) { setLoading(false); return }
    setLoading(true); setError('')
    Promise.all([fetchAssets(baseUrl), fetchBrandProfile(baseUrl), fetchApiHealth(baseUrl)]).then(([nextAssets, nextBrand, health]) => { setAssets(nextAssets); setBrand(nextBrand.profile); setAssetStorageReady(health?.setup?.objectStorage?.configured === true) }).catch(cause => setError(describeApiError(cause))).finally(() => setLoading(false))
  }
  useEffect(load, [baseUrl])
  useEffect(() => {
    if (!assetStorageReady) { setAssetPreviews({}); return }
    const controller = new AbortController()
    const createdUrls: string[] = []
    let disposed = false
    const images = (assets ?? []).filter(asset => asset.mimeType.startsWith('image/') && !asset.mimeType.includes('svg'))
    void Promise.all(images.map(async asset => {
      try {
        const blob = await fetchAssetBlob(baseUrl ?? '', asset.id, controller.signal)
        const url = URL.createObjectURL(blob)
        createdUrls.push(url)
        return [asset.id, url] as const
      } catch (cause) {
        if (controller.signal.aborted) return null
        setBrandMessage(current => current || describeApiError(cause))
        return null
      }
    })).then(entries => {
      if (!disposed) setAssetPreviews(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))))
    })
    return () => {
      disposed = true
      controller.abort()
      for (const url of createdUrls) URL.revokeObjectURL(url)
    }
  }, [baseUrl, assets, assetStorageReady])
  useEffect(() => {
    const rules = brand?.visualRules
    setVisualLogoIds(rules?.logo?.assetIds ?? [])
    setLogoRecolor(rules?.logo?.allowRecolor ?? false); setLogoDistortion(rules?.logo?.allowDistortion ?? false); setLogoRedraw(rules?.logo?.allowRedraw ?? false)
    setVisualPrimary(rules?.colors?.primary.join(', ') ?? ''); setVisualSecondary(rules?.colors?.secondary.join(', ') ?? ''); setVisualForbidden(rules?.colors?.forbidden.join(', ') ?? '')
    setVisualFonts(rules?.fonts?.map(font => font.family).join(', ') ?? ''); setVisualFontLicense(rules?.fonts?.[0]?.licenseStatus ?? 'unknown'); setVisualStyles(rules?.styleKeywords?.join(', ') ?? '')
    setRestrictedPeople(rules?.restrictedSubjects?.people.join(', ') ?? ''); setRestrictedSpokespersons(rules?.restrictedSubjects?.spokespersons.join(', ') ?? ''); setRestrictedIps(rules?.restrictedSubjects?.intellectualProperties.join(', ') ?? ''); setRestrictedContent(rules?.restrictedSubjects?.prohibitedContent.join(', ') ?? '')
  }, [brand?.revision])
  const statusLabel = (asset: AssetMetadata) => asset.scanStatus !== 'clean' ? '待安全扫描' : asset.rightsStatus === 'approved' ? '权益已确认' : '待权益确认'
  const statusTone = (asset: AssetMetadata) => asset.scanStatus === 'clean' && asset.rightsStatus === 'approved' ? 'green' : 'amber'
  const uploadFiles = async (files: FileList | null) => {
    if (!baseUrl || !files?.length) return
    const selected = Array.from(files)
    if (selected.some(file => file.size === 0)) { setBrandMessage('不能上传空文件。'); return }
    if (selected.some(file => file.size > 50 * 1024 * 1024)) { setBrandMessage('单个素材不能超过 50MB。'); return }
    setUploadAction(`正在上传 1/${selected.length}…`); setBrandMessage('')
    try {
      for (const [index, file] of selected.entries()) {
        setUploadAction(`正在上传 ${index + 1}/${selected.length}…`)
        await uploadAsset(baseUrl, file)
      }
      await load()
      setBrandMessage(`已上传 ${selected.length} 个素材；当前处于隔离区，完成安全扫描与权益确认后才能用于生成。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setUploadAction(''); if (uploadInput.current) uploadInput.current.value = '' }
  }
  const extractBrand = async () => {
    if (!baseUrl) return
    setBrandAction('正在提取品牌字段…'); setBrandMessage('')
    try {
      const result = await extractBrandProfile(baseUrl, assets?.filter(asset => asset.parseStatus === 'succeeded').map(asset => asset.id))
      setExtraction(result); setSelectedBrandFields([]); setSelectedAlternatives({})
      setBrandMessage(Object.keys(result.fields).length ? '候选字段尚未写入，请逐项核对并勾选确认。' : result.warnings[0] ?? '没有识别到候选字段。')
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setBrandAction('') }
  }
  const confirmBrand = async () => {
    if (!baseUrl || !extraction || !selectedBrandFields.length) return
    const selected = Object.fromEntries(selectedBrandFields.map(key => [key, extraction.fields[key]?.alternatives[selectedAlternatives[key] ?? 0]?.value ?? extraction.fields[key]?.value])) as Partial<Record<BrandCandidateFieldKey, string | string[]>>
    const name = typeof selected.name === 'string' ? selected.name : brand?.name
    if (!name) { setBrandMessage('首次建档必须确认“品牌名称”。'); return }
    const detailKeys = ['logoRules', 'colors', 'fonts', 'rights'] as const
    const details = Object.fromEntries(detailKeys.filter(key => selectedBrandFields.includes(key)).map(key => [key, selected[key]]))
    const resolutions = Object.fromEntries([...selectedBrandFields.filter(key => !detailKeys.includes(key as typeof detailKeys[number])).map(key => [key, 'candidate']), ...(Object.keys(details).length ? [['details', 'candidate']] : [])]) as Record<string, 'candidate'>
    setBrandAction('正在保存已确认字段…'); setBrandMessage('')
    try {
      const saved = await saveBrandProfile(baseUrl, { name, ...(typeof selected.positioning === 'string' ? { positioning: selected.positioning } : {}), ...(typeof selected.audience === 'string' ? { audience: selected.audience } : {}), ...(Array.isArray(selected.tone) ? { tone: selected.tone } : {}), ...(Array.isArray(selected.forbiddenTerms) ? { forbidden_terms: selected.forbiddenTerms } : {}), ...(Object.keys(details).length ? { details: { ...(brand?.details ?? {}), ...details } } : {}), source: `brand.extract:${extraction.assetIds.join(',')}`, conflict_resolutions: resolutions })
      setBrand(saved); setExtraction(null); setSelectedBrandFields([]); setBrandMessage(`品牌档案 r${saved.revision} 已保存；未勾选字段没有写入。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setBrandAction('') }
  }
  const toggleBrandField = (key: BrandCandidateFieldKey) => setSelectedBrandFields(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key])
  const displayBrandValue = (value: string | string[]) => Array.isArray(value) ? value.join('、') : value
  const splitValues = (value: string) => value.split(/[,，\n]/u).map(item => item.trim()).filter(Boolean)
  const openPreferenceEditor = (asset: AssetMetadata) => {
    setPreferenceAssetId(asset.id); setPreferenceVerdict(asset.preference?.verdict ?? 'excellent'); setPreferenceReasons(asset.preference?.reasons.join('，') ?? ''); setPreferenceNote(asset.preference?.note ?? ''); setBrandMessage('')
  }
  const openAsset = async (asset: AssetMetadata) => {
    if (!baseUrl) return
    const target = window.open('', '_blank', 'noopener,noreferrer')
    try {
      const blob = await fetchAssetBlob(baseUrl, asset.id)
      const url = URL.createObjectURL(blob)
      if (target) target.location.href = url
      else window.open(url, '_blank', 'noopener,noreferrer')
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (cause) {
      target?.close()
      setBrandMessage(describeApiError(cause))
    }
  }
  const savePreference = async (asset: AssetMetadata) => {
    if (!baseUrl) return
    const reasons = splitValues(preferenceReasons)
    if (!reasons.length) { setBrandMessage('评价历史素材必须填写至少一条具体原因。'); return }
    setPreferenceAction('正在保存素材评价…'); setBrandMessage('')
    try {
      const saved = await saveAssetPreference(baseUrl, asset.id, { verdict: preferenceVerdict, reasons, ...(preferenceNote.trim() ? { note: preferenceNote.trim() } : {}), expected_revision: asset.revision })
      setAssets(current => current?.map(item => item.id === saved.id ? saved : item) ?? null); setPreferenceAssetId(''); setBrandMessage(saved.preference?.verdict === 'excellent' ? `已将“${saved.name}”标记为优秀素材；仅在扫描、权益和平台条件满足时进入后续任务参考快照。` : `已将“${saved.name}”标记为不喜欢素材；后续任务会排除该素材，显式选择时将被阻止。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setPreferenceAction('') }
  }
  const clearPreference = async (asset: AssetMetadata) => {
    if (!baseUrl) return
    setPreferenceAction('正在清除评价…'); setBrandMessage('')
    try {
      const saved = await saveAssetPreference(baseUrl, asset.id, { verdict: 'unrated', expected_revision: asset.revision })
      setAssets(current => current?.map(item => item.id === saved.id ? saved : item) ?? null); setPreferenceAssetId(''); setBrandMessage(`已清除“${saved.name}”的历史素材评价。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setPreferenceAction('') }
  }
  const confirmRights = async (asset: AssetMetadata) => {
    if (!baseUrl) return
    if (asset.scanStatus !== 'clean') { setBrandMessage('素材必须先由安全扫描服务标记为 clean，不能在页面内伪造扫描结果。'); return }
    const scope = window.prompt('素材权益范围：owned / commercial_authorized / limited_use / internal_only', asset.rightsScope ?? 'commercial_authorized')?.trim()
    if (!scope) return
    if (!['owned', 'commercial_authorized', 'limited_use', 'internal_only'].includes(scope)) { setBrandMessage('权益范围无效，请重新选择。'); return }
    setAssetAction(`rights-${asset.id}`); setBrandMessage('')
    try {
      const saved = await updateAssetRights(baseUrl, asset.id, { rights_status: 'approved', rights_scope: scope, usage_scopes: ['commercial', 'ai_generation'], ai_modification_allowed: false })
      setAssets(current => current?.map(item => item.id === saved.id ? saved : item) ?? null); setBrandMessage(`已确认“${saved.name}”的商用权益；如需改图，仍需单独确认 AI 修改许可。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setAssetAction('') }
  }
  const confirmFacts = async (asset: AssetMetadata) => {
    if (!baseUrl) return
    if (asset.scanStatus !== 'clean') { setBrandMessage('素材必须先完成安全扫描。'); return }
    const rawFacts = window.prompt('请输入已核对的素材事实 JSON（例如 {"用途":"商品主图"}）', JSON.stringify(asset.extractedFacts ?? { 用途: '待核对' }))
    if (!rawFacts) return
    let facts: Record<string, unknown>
    try { const parsed: unknown = JSON.parse(rawFacts); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) throw new Error('empty'); facts = parsed as Record<string, unknown> } catch { setBrandMessage('事实必须是非空 JSON 对象，未保存。'); return }
    const reason = window.prompt('请说明核对来源或确认原因', '商家已核对原始资料')?.trim()
    if (!reason) return
    setAssetAction(`facts-${asset.id}`); setBrandMessage('')
    try {
      const saved = await confirmAssetFacts(baseUrl, asset.id, facts, reason)
      setAssets(current => current?.map(item => item.id === saved.id ? saved : item) ?? null); setBrandMessage(`已人工确认“${saved.name}”的素材事实；后续会保留 manual 来源。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setAssetAction('') }
  }
  const parse = async (asset: AssetMetadata) => {
    if (!baseUrl || asset.scanStatus !== 'clean') return
    setAssetAction(`parse-${asset.id}`); setBrandMessage('')
    try {
      const parsed = await parseAsset(baseUrl, asset.id)
      setAssets(current => current?.map(item => item.id === parsed.id ? parsed : item) ?? null)
      setBrandMessage(parsed.parseStatus === 'succeeded' ? `“${parsed.name}”已完成事实解析；如需作为可用事实，还要确认解析结果。` : `“${parsed.name}”解析未完成，请使用人工事实确认。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setAssetAction('') }
  }
  const saveVisualRules = async () => {
    if (!baseUrl || !brand) { setBrandMessage('请先确认品牌名称，再配置视觉强规则。'); return }
    const primary = splitValues(visualPrimary); const secondary = splitValues(visualSecondary); const forbidden = splitValues(visualForbidden); const fontFamilies = splitValues(visualFonts); const styles = splitValues(visualStyles)
    const people = splitValues(restrictedPeople); const spokespersons = splitValues(restrictedSpokespersons); const intellectualProperties = splitValues(restrictedIps); const prohibitedContent = splitValues(restrictedContent)
    const visualRules: BrandVisualRules = {
      ...(visualLogoIds.length ? { logo: { assetIds: visualLogoIds, allowRecolor: logoRecolor, allowDistortion: logoDistortion, allowRedraw: logoRedraw } } : {}),
      ...(primary.length || secondary.length || forbidden.length ? { colors: { primary, secondary, forbidden } } : {}),
      ...(fontFamilies.length ? { fonts: fontFamilies.map(family => ({ family, licenseStatus: visualFontLicense })) } : {}),
      ...(styles.length ? { styleKeywords: styles } : {}),
      ...(people.length || spokespersons.length || intellectualProperties.length || prohibitedContent.length ? { restrictedSubjects: { people, spokespersons, intellectualProperties, prohibitedContent } } : {}),
    }
    setBrandAction('正在校验视觉强规则…'); setBrandMessage('')
    try {
      const saved = await saveBrandProfile(baseUrl, { name: brand.name, visual_rules: visualRules, source: 'merchant_studio:visual-rules', conflict_resolutions: { visualRules: 'candidate' } })
      setBrand(saved); setBrandMessage(`品牌视觉强规则已保存到 r${saved.revision}；之后所有内容、主图和创意生成都会先执行阻断检查。`)
    } catch (cause) { setBrandMessage(describeApiError(cause)) } finally { setBrandAction('') }
  }
  return <section className="panel asset-library" aria-label="素材库">
    <div className="panel-heading"><div><span className="section-kicker">ASSET LIBRARY</span><h3>素材库</h3><p className="panel-subtitle">先确认素材安全与使用权益，再用于商品详情、主图和营销内容。</p></div><div className="asset-heading-actions"><input ref={uploadInput} data-testid="asset-upload-input" className="sr-only" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.gif,.svg,.pdf,.docx,.xlsx,.json,.txt,.md,.csv,.ai,.eps,image/jpeg,image/png,image/webp,image/gif,image/svg+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,text/plain,text/markdown,text/csv,application/postscript" onChange={event => void uploadFiles(event.target.files)} /><button className="secondary" onClick={() => uploadInput.current?.click()} disabled={!baseUrl || Boolean(uploadAction)}><Upload size={14}/>{uploadAction || '上传素材'}</button><button className="secondary" onClick={load} disabled={!baseUrl || loading || Boolean(assetAction)}><RefreshCw size={14} className={loading ? 'spin' : undefined}/>刷新状态</button><StatusChip tone={brand ? 'green' : 'neutral'}>{brand ? `品牌档案 r${brand.revision}` : '品牌未建档'}</StatusChip><StatusChip tone={assets?.length ? 'green' : 'neutral'}>{assets?.length ?? 0} 个素材</StatusChip><button data-testid="visual-rules-toggle" className="secondary" onClick={() => setVisualPanelOpen(current => !current)} disabled={!brand}><ShieldCheck size={14}/>{visualPanelOpen ? '收起视觉规则' : '配置视觉强规则'}</button><button className="secondary" onClick={extractBrand} disabled={!baseUrl || Boolean(brandAction) || !assets?.some(asset => asset.parseStatus === 'succeeded')}><Sparkles size={14}/>{brandAction || '从素材提取品牌档案'}</button></div></div>
    <div data-testid="asset-untrusted-boundary" className="info-notice"><ShieldCheck size={15}/>上传文件内容始终按不可信数据读取：不会执行其中指令、改变系统规则或自动调用工具；提取结果需由商家确认。</div>
    {brandMessage && <div className="info-notice" role="status"><CircleHelp size={15}/>{brandMessage}</div>}
    {visualPanelOpen && <section className="visual-rules-panel" aria-label="品牌视觉强规则"><div className="brand-candidate-head"><div><span className="section-kicker">HARD CONSTRAINTS</span><h4>Logo、品牌色与字体强规则</h4><p>这些不是参考建议：任一素材或字体授权不满足时，内容、主图和创意生成都会被阻止。</p></div><button data-testid="visual-rules-save" className="primary" onClick={saveVisualRules} disabled={Boolean(brandAction)}>{brandAction || '校验并保存强规则'}</button></div><div className="visual-rules-grid"><fieldset><legend>Logo 素材</legend><div className="visual-asset-options">{assets?.filter(asset => asset.mimeType.startsWith('image/')).map(asset => <label key={asset.id}><input type="checkbox" checked={visualLogoIds.includes(asset.id)} onChange={() => setVisualLogoIds(current => current.includes(asset.id) ? current.filter(id => id !== asset.id) : [...current, asset.id])}/><span>{asset.name}<small>{statusLabel(asset)}</small></span></label>)}</div><div className="visual-logo-guards"><label><input type="checkbox" checked={logoRecolor} onChange={event => setLogoRecolor(event.target.checked)}/>允许改色</label><label><input type="checkbox" checked={logoDistortion} onChange={event => setLogoDistortion(event.target.checked)}/>允许变形</label><label><input type="checkbox" checked={logoRedraw} onChange={event => setLogoRedraw(event.target.checked)}/>允许重绘</label></div><small>默认全部禁止。开启任一项时，Logo 素材还必须明确允许 AI 修改。</small></fieldset><fieldset><legend>品牌色（#RRGGBB，逗号分隔）</legend><label>主色<input data-testid="visual-primary" value={visualPrimary} onChange={event => setVisualPrimary(event.target.value)} placeholder="#123456, #FFFFFF"/></label><label>辅助色<input data-testid="visual-secondary" value={visualSecondary} onChange={event => setVisualSecondary(event.target.value)} placeholder="#E5E7EB"/></label><label>禁用色<input data-testid="visual-forbidden" value={visualForbidden} onChange={event => setVisualForbidden(event.target.value)} placeholder="#FF0000"/></label></fieldset><fieldset><legend>字体与风格</legend><label>字体名称<input data-testid="visual-fonts" value={visualFonts} onChange={event => setVisualFonts(event.target.value)} placeholder="思源黑体, HarmonyOS Sans"/></label><label>字体授权<select data-testid="visual-font-license" value={visualFontLicense} onChange={event => setVisualFontLicense(event.target.value as typeof visualFontLicense)}><option value="approved">已批准</option><option value="restricted">受限</option><option value="unknown">待确认</option></select></label><label>风格关键词<input data-testid="visual-styles" value={visualStyles} onChange={event => setVisualStyles(event.target.value)} placeholder="克制, 轻户外, 高留白"/></label><small className={visualFontLicense === 'approved' ? 'visual-ready' : 'visual-blocked'}>{visualFontLicense === 'approved' ? '字体规则可进入生成前检查' : '当前字体授权会阻止生成'}</small></fieldset></div></section>}
    {extraction && <section className="brand-candidate-panel" aria-label="品牌候选字段"><div className="brand-candidate-head"><div><span className="section-kicker">REVIEW BEFORE SAVE</span><h4>逐字段确认品牌档案</h4><p>自动提取不会直接写入。置信度仅代表解析把握，不代表内容正确。</p></div><button className="primary" onClick={confirmBrand} disabled={!selectedBrandFields.length || Boolean(brandAction)}>{brandAction || `保存已确认字段（${selectedBrandFields.length}）`}</button></div><div className="brand-candidate-grid">{Object.values(extraction.fields).filter((field): field is NonNullable<typeof field> => Boolean(field)).map(field => <article className={`brand-candidate ${field.status}`} key={field.key}><div className="brand-candidate-title"><label><input type="checkbox" checked={selectedBrandFields.includes(field.key)} onChange={() => toggleBrandField(field.key)}/><b>{field.label}</b></label><StatusChip tone={field.status === 'conflict' ? 'amber' : field.confidence >= .85 ? 'green' : 'blue'}>{Math.round(field.confidence * 100)}% · {field.status === 'conflict' ? '存在冲突' : '待确认'}</StatusChip></div>{field.alternatives.map((alternative, index) => <label className="brand-alternative" key={`${field.key}-${index}`}><input type="radio" name={`brand-${field.key}`} checked={(selectedAlternatives[field.key] ?? 0) === index} onChange={() => setSelectedAlternatives(current => ({ ...current, [field.key]: index }))}/><span><b>{displayBrandValue(alternative.value)}</b><small>来自 {alternative.sourceAssetIds.length} 份素材 · 置信度 {Math.round(alternative.confidence * 100)}%</small></span></label>)}<small className="brand-source">依据：{[...new Set(field.sources.map(source => `${source.assetName} · ${source.reference}`))].join('；')}</small></article>)}</div>{extraction.ignoredAssets.length > 0 && <small className="brand-ignored">另有 {extraction.ignoredAssets.length} 份素材未读取，未参与本次提取。</small>}</section>}
    {visualPanelOpen && <section className="visual-rules-panel restricted-subjects-panel" aria-label="禁用内容与主体强规则"><div className="brand-candidate-head"><div><span className="section-kicker">PROHIBITED SUBJECTS</span><h4>禁用内容、人物、代言人与 IP</h4><p>生成提示和确定性文案审核都会使用这些强规则；图片中的人物/IP 像素识别仍需外部视觉服务复核。</p></div></div><div className="visual-rules-grid"><fieldset><legend>禁用人物与代言人</legend><label>人物<input data-testid="restricted-people" value={restrictedPeople} onChange={event => setRestrictedPeople(event.target.value)} placeholder="人物姓名，逗号分隔"/></label><label>代言人<input data-testid="restricted-spokespersons" value={restrictedSpokespersons} onChange={event => setRestrictedSpokespersons(event.target.value)} placeholder="代言人姓名，逗号分隔"/></label></fieldset><fieldset><legend>禁用 IP 与内容</legend><label>IP / 角色<input data-testid="restricted-ips" value={restrictedIps} onChange={event => setRestrictedIps(event.target.value)} placeholder="IP、角色或作品名，逗号分隔"/></label><label>内容<input data-testid="restricted-content" value={restrictedContent} onChange={event => setRestrictedContent(event.target.value)} placeholder="禁用场景、主题或表现，逗号分隔"/></label><small>填写后请点击上方“校验并保存强规则”。</small></fieldset></div></section>}
    {!baseUrl && <div className="info-notice"><CircleHelp size={15}/>连接 API 后读取真实素材；离线模式不会伪造素材权益。</div>}
    {loading && <LoadingState label="正在读取素材库…" />}
    {error && <ErrorNotice message={error} onRetry={load} compact />}
    {!loading && !error && baseUrl && !assets?.length && <div className="asset-empty"><FileText size={24}/><b>素材库还没有内容</b><span>请先上传商品原图、品牌资料或权益证明，再开始生成内容。</span></div>}
    {!loading && !error && !!assets?.length && <div className="asset-grid">{assets.map(asset => <article className={`asset-card ${asset.preference?.verdict ?? ''}`} key={asset.id} data-asset-name={asset.name}><div className="asset-preview" title={assetStorageReady ? undefined : '对象存储未配置，暂不读取素材正文'}>{assetPreviews[asset.id] ? <img src={assetPreviews[asset.id]} alt={asset.name} /> : <FileText size={28}/>}</div><div className="asset-card-body"><div className="asset-title-row"><b title={asset.name}>{asset.name}</b>{asset.preference && <StatusChip tone={asset.preference.verdict === 'excellent' ? 'green' : 'amber'}>{asset.preference.verdict === 'excellent' ? '优秀参考' : '不喜欢'}</StatusChip>}</div><span>{asset.mimeType} · {Math.max(1, Math.round(asset.sizeBytes / 1024))} KB</span><div className="asset-status"><StatusChip tone={statusTone(asset)}>{statusLabel(asset)}</StatusChip><span>{asset.parseStatus === 'succeeded' ? '已读取内容' : asset.parseStatus === 'failed' ? '读取失败' : '待读取'}</span></div>{asset.references?.length > 1 && <small data-testid={`asset-reference-count-${asset.id}`} className="asset-preference-reason">同一文件已有 {asset.references.length} 个上传引用：{asset.references.map(reference => reference.name).join('、')}</small>}{asset.preference && <small className="asset-preference-reason">原因：{asset.preference.reasons.join('；')}</small>}{asset.parseError && <small className="asset-error">{asset.parseError}</small>}<div className="asset-card-actions"><button className="text-button" onClick={() => void openAsset(asset)} disabled={!baseUrl || !assetStorageReady}>{assetStorageReady ? '打开并阅读' : '存储未配置'}</button><button data-testid={`asset-preference-open-${asset.id}`} className="text-button" onClick={() => openPreferenceEditor(asset)}>评价素材</button></div><div className="asset-card-actions"><button className="text-button" onClick={() => void parse(asset)} disabled={!baseUrl || asset.scanStatus !== 'clean' || asset.parseStatus === 'succeeded' || Boolean(assetAction)}>{assetAction === `parse-${asset.id}` ? '解析中…' : asset.parseStatus === 'succeeded' ? '已完成解析' : asset.scanStatus === 'clean' ? '解析素材' : '等待扫描'}</button><button className="text-button" onClick={() => void confirmRights(asset)} disabled={!baseUrl || asset.scanStatus !== 'clean' || asset.rightsStatus === 'approved' || Boolean(assetAction)}>{assetAction === `rights-${asset.id}` ? '保存中…' : asset.rightsStatus === 'approved' ? '权益已确认' : asset.scanStatus === 'clean' ? '确认权益' : '等待扫描'}</button><button className="text-button" onClick={() => void confirmFacts(asset)} disabled={!baseUrl || asset.scanStatus !== 'clean' || Boolean(assetAction)}>{assetAction === `facts-${asset.id}` ? '保存中…' : asset.factsConfirmedBy ? '事实已确认' : asset.scanStatus === 'clean' ? '确认事实' : '等待扫描'}</button></div>{preferenceAssetId === asset.id && <div className="asset-preference-editor" aria-label={`评价素材 ${asset.name}`}><label>评价<select data-testid="asset-preference-verdict" value={preferenceVerdict} onChange={event => setPreferenceVerdict(event.target.value as 'excellent' | 'disliked')}><option value="excellent">优秀，后续作为参考</option><option value="disliked">不喜欢，后续排除</option></select></label><label>原因<input data-testid="asset-preference-reasons" value={preferenceReasons} onChange={event => setPreferenceReasons(event.target.value)} placeholder="如：主体清晰、留白合适"/></label><label>补充说明<input value={preferenceNote} onChange={event => setPreferenceNote(event.target.value)} placeholder="可选，最多 500 字"/></label><div><button data-testid="asset-preference-save" className="primary" onClick={() => savePreference(asset)} disabled={Boolean(preferenceAction)}>{preferenceAction || '保存评价'}</button>{asset.preference && <button className="secondary" onClick={() => clearPreference(asset)} disabled={Boolean(preferenceAction)}>清除评价</button>}<button className="secondary" onClick={() => setPreferenceAssetId('')} disabled={Boolean(preferenceAction)}>取消</button></div></div>}</div></article>)}</div>}
  </section>
}

function Products({ baseUrl, initialQuery = '', onSelectTarget }: { baseUrl?: string; initialQuery?: string; onSelectTarget: (target: Target) => void }) {
  const accountsRequestId = useRef(0)
  const [query, setQuery] = useState(initialQuery)
  const [remoteProducts, setRemoteProducts] = useState<ApiProduct[] | null>(null)
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(baseUrl ? null : [])
  const [accountsLoading, setAccountsLoading] = useState(Boolean(baseUrl))
  const [accountsError, setAccountsError] = useState('')
  const [selectedTargets, setSelectedTargets] = useState<Target[]>([])
  const [productFilter, setProductFilter] = useState<'all' | 'needsReview' | 'syncIssues'>('all')
  const [groupCreating, setGroupCreating] = useState(false)
  const [groupMessage, setGroupMessage] = useState('')
  const loadProducts = () => {
    if (!baseUrl) return
    setLoading(true); setError(''); setRemoteProducts(null); setSelectedTargets([])
    fetchProducts(baseUrl).then(setRemoteProducts).catch((cause: Error) => { setRemoteProducts(null); setError(describeApiError(cause)) }).finally(() => setLoading(false))
  }
  const loadAccounts = () => {
    const requestId = ++accountsRequestId.current
    if (!baseUrl) { setAccounts([]); setAccountsLoading(false); setAccountsError(''); return }
    setAccountsLoading(true); setAccountsError(''); setAccounts(null)
    fetchPlatformAccounts(baseUrl)
      .then(result => { if (requestId === accountsRequestId.current) setAccounts(result.items) })
      .catch(cause => { if (requestId === accountsRequestId.current) { setAccounts(null); setAccountsError(`店铺发现失败：${describeApiError(cause)}。为避免同步到错误店铺，已停止全部同步。`) } })
      .finally(() => { if (requestId === accountsRequestId.current) setAccountsLoading(false) })
  }
  useEffect(() => { loadProducts(); loadAccounts() }, [baseUrl])
  useEffect(() => { setQuery(initialQuery) }, [initialQuery])
  const rows = remoteProducts
    ? remoteProducts.map(product => ({ id: product.id, platformId: product.platform, accountId: product.accountId, storeName: product.storeName, title: product.title, remoteId: product.remoteId, name: product.title, sku: `${product.skuCount} SKU`, platform: platformLabel[product.platform] ?? product.platform, source: product.source === 'official_api' ? '官方 API' : '演示数据', status: product.factsConfirmed ? '事实已确认' : '待确认', stock: product.stock, issue: product.factsConfirmed ? 0 : 1 }))
    : baseUrl
      ? []
      : products.map((product, index) => ({ ...product, id: `prod_fixture_${index + 1}`, platformId: (Object.entries(platformLabel).find(([, label]) => label === product.platform)?.[0] ?? 'taobao') as PlatformId, title: product.name, remoteId: undefined, accountId: undefined, storeName: '离线演示店铺' }))
  const visible = useMemo(() => rows.filter(p => {
    if (!(p.name.includes(query) || p.platform.includes(query) || p.storeName.includes(query))) return false
    if (productFilter === 'needsReview') return p.issue > 0
    if (productFilter === 'syncIssues') return p.status === '同步已过期'
    return true
  }), [productFilter, query, rows])
  const productStats = useMemo(() => ({
    total: rows.length,
    needsReview: rows.filter(product => product.issue > 0).length,
    syncIssues: rows.filter(product => product.status === '同步已过期').length,
  }), [rows])
  const sync = async () => {
    if (!baseUrl) return
    const resolution = resolveStoreSyncTargets(accounts)
    if (!resolution.ok) { setError(resolution.message); return }
    setError(''); setSyncing(true)
    try {
      const results = await Promise.allSettled(resolution.targets.map(target => syncPlatform(baseUrl, target.platform, target.accountId)))
      const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${platformNames[resolution.targets[index].platform]} · ${resolution.targets[index].label}：${describeApiError(result.reason)}`] : [])
      try { setRemoteProducts(await fetchProducts(baseUrl)) } catch (cause) { failures.push(`商品列表刷新失败：${describeApiError(cause)}`) }
      if (failures.length) setError(`部分店铺同步失败；未自动改选其他店铺。${failures.join('；')}`)
    } finally { setSyncing(false) }
  }
  const importLocalProduct = async () => {
    if (!baseUrl) return
    const title = window.prompt('商品名称（必填）', '')?.trim()
    if (!title) return
    const platform = (window.prompt('目标平台：jd / taobao / tmall / pinduoduo / xiaohongshu / douyin', 'taobao')?.trim() || 'taobao') as PlatformId
    if (!(['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] as string[]).includes(platform)) { setError('目标平台无效'); return }
    try {
      await importProduct(baseUrl, { platform, title, local_product_key: `${platform}:${title}`, category: window.prompt('平台类目（创建商品必填）', '')?.trim() || undefined, price: Number(window.prompt('价格', '0') || 0), stock: Number(window.prompt('库存', '0') || 0) })
      await loadProducts()
    } catch (cause) { setError(describeApiError(cause)) }
  }
  const toggleTarget = (target: Target) => setSelectedTargets(current => current.some(item => item.productId === target.productId) ? current.filter(item => item.productId !== target.productId) : [...current.filter(item => item.platform !== target.platform), target])
  const createGroup = async () => {
    if (!baseUrl || selectedTargets.length < 2) return
    const summary = selectedTargets.map(item => `${platformNames[item.platform]}：${item.title}`).join('\n')
    if (!window.confirm(`将创建 ${selectedTargets.length} 个相互独立的平台子任务：\n${summary}\n\n各子任务分别保存规则、版本与发布回执。确认创建吗？`)) return
    setGroupCreating(true); setError(''); setGroupMessage('')
    try {
      const result = await createTaskGroup(baseUrl, selectedTargets.map(item => ({ product_id: item.productId, platform: item.platform, ...(item.accountId ? { account_id: item.accountId } : {}) })), '多平台同步发布任务')
      setGroupMessage(`已创建多平台任务组 ${result.id}，包含 ${result.tasks.length} 个独立子任务；可在“营销任务”中分别恢复和处理。`)
      setSelectedTargets([])
    } catch (cause) { setError(describeApiError(cause)) } finally { setGroupCreating(false) }
  }
  const checkImages = async (productId: string) => {
    if (!baseUrl) return
    try {
      const result = await reviewProductImages(baseUrl, productId)
      const blocking = result.findings.filter(finding => finding.severity === 'error')
      window.alert(blocking.length ? `主图检查阻断：${blocking.map(finding => finding.message).join('；')}` : `主图确定性检查通过。仍需外部验证：${result.externallyUnverified.join('、')}`)
    } catch (cause) { setError(describeApiError(cause)) }
  }
  return <div className="page-stack">
    <section className="page-intro"><div><span className="section-kicker">COMMERCE FACTS</span><h2>一处管理商品事实与来源</h2><p>平台原值、本地确认值和来源证据同时保留。AI 不会覆盖你的商品真相。</p></div><div className="button-row"><button className="secondary" onClick={importLocalProduct} disabled={!baseUrl}>导入待创建商品</button><button className="secondary" onClick={createGroup} disabled={!baseUrl || selectedTargets.length < 2 || groupCreating}>{groupCreating ? '创建任务组中…' : `创建多平台任务组${selectedTargets.length ? `（${selectedTargets.length}）` : ''}`}</button><button className="primary" onClick={() => void sync()} disabled={loading || syncing || accountsLoading || Boolean(accountsError) || !baseUrl}><RefreshCw size={17} className={loading || syncing || accountsLoading ? 'spin' : undefined} />{syncing ? '同步全部店铺…' : accountsLoading ? '正在发现店铺…' : baseUrl ? '同步全部店铺' : '演示数据'}</button></div></section>
    <AssetLibrary baseUrl={baseUrl} />
    {!baseUrl && <div className="info-notice" role="status"><CircleHelp size={16} />当前为离线演示，配置 <code>VITE_API_BASE_URL</code> 后可读取真实商品并执行同步。</div>}
    {accountsError && <ErrorNotice message={accountsError} onRetry={loadAccounts} />}
    {!accountsLoading && !accountsError && accounts && <div className="info-notice" role="status"><Store size={16}/>{accounts.filter(account => account.readEnabled && account.accountId).length ? `已发现 ${accounts.filter(account => account.readEnabled && account.accountId).length} 家可同步店铺；同步会逐店执行，不会默认选择同平台第一家店。` : '未发现已授权且可读取的店铺；不会发起同步。'}</div>}
    {groupMessage && <div data-testid="task-group-created" className="info-notice" role="status"><CheckCircle2 size={16}/>{groupMessage}</div>}
    {error && <ErrorNotice message={error} onRetry={loadProducts} />}
    <section className="panel table-panel">
      <div className="table-toolbar"><label className="inline-search"><Search size={16} /><span className="sr-only">搜索商品</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索商品或平台" /></label><div className="filter-group"><button className={'filter ' + (productFilter === 'all' ? 'active' : '')} onClick={() => setProductFilter('all')}>全部 {productStats.total}</button><button className={'filter ' + (productFilter === 'needsReview' ? 'active' : '')} onClick={() => setProductFilter('needsReview')}>待确认 {productStats.needsReview}</button><button className={'filter ' + (productFilter === 'syncIssues' ? 'active' : '')} onClick={() => setProductFilter('syncIssues')}>同步异常 {productStats.syncIssues}</button></div></div>
      {selectedTargets.length > 0 && <div data-testid="task-group-selection" className="task-group-selection"><div><b>多平台任务组选择</b><small>每个平台只能选择一个商品；重新勾选同平台商品会替换原选择。</small></div>{selectedTargets.map(item => <span key={item.platform}><StatusChip tone="green">{platformNames[item.platform]}</StatusChip>{item.title} · {item.storeName}</span>)}</div>}
      <div className="table-wrap">{loading ? <LoadingState label="正在读取商品事实…" /> : error && baseUrl ? <div className="empty-state" data-testid="products-unavailable"><AlertCircle size={22} /><b>商品列表暂不可用</b><span>当前未展示任何演示商品。请先重试并读取真实商品。</span></div> : visible.length ? <table><thead><tr><th>任务组</th><th>商品</th><th>平台</th><th>店铺</th><th>事实来源</th><th>可售库存</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visible.map(product => { const target = { productId: product.id, platform: product.platformId, title: product.title, remoteId: product.remoteId, accountId: product.accountId, storeName: product.storeName }; const identityError = validateTargetStoreIdentity(target); return <tr key={product.id}><td><input type="checkbox" aria-label={`选择${product.name}（${product.storeName}）加入任务组`} checked={selectedTargets.some(item => item.productId === product.id)} onChange={() => toggleTarget(target)} disabled={!baseUrl || Boolean(error) || Boolean(identityError)} /></td><td><div className="product-cell"><div className="product-thumb"><ShoppingBag size={20} /></div><div><b>{product.name}</b><span>{product.sku}</span></div></div></td><td>{product.platform}</td><td><div className="store-identity"><b>{product.storeName}</b><span>{product.accountId ? `账号 ${product.accountId}` : '缺少账号 ID'}</span></div></td><td><StatusChip tone="neutral"><Link2 size={12} />{product.source}</StatusChip></td><td>{product.stock.toLocaleString()}</td><td><StatusChip tone={identityError ? 'amber' : product.issue ? 'amber' : 'green'}>{identityError || (product.issue ? <><AlertCircle size={12} />{product.status}</> : <><Check size={12} />{product.status}</>)}</StatusChip></td><td><button className="text-button" onClick={() => checkImages(product.id)} disabled={!baseUrl || Boolean(error)}>主图检查</button><button className="text-button" onClick={() => onSelectTarget(target)} disabled={!baseUrl || Boolean(error) || Boolean(identityError)} title={identityError ?? (!baseUrl ? '配置 API 后可创建真实任务' : undefined)}>创建任务 <ArrowRight size={14} /></button></td></tr>})}</tbody></table> : <div className="empty-state"><PackageSearch size={22} /><b>没有匹配商品</b><span>调整搜索条件，或重新同步平台商品。</span></div>}</div>
      <div className="table-footer"><span>显示 {visible.length} / {productStats.total} 个商品</span><div><button disabled>上一页</button><button disabled>下一页</button></div></div>
    </section>
  </div>
}

type TaskContext = { task: Task; version: ContentVersion }

function ProductDetailPreview({ content, title, product }: { content: ContentVersion | null; title: string; product: ApiProduct | null }) {
  const [imageIndex, setImageIndex] = useState(0)
  const [moduleFilter, setModuleFilter] = useState<'all' | 'fact' | 'creative' | 'pending'>('all')
  const images = product?.images?.filter(Boolean) ?? []
  const attributes = Object.entries(product?.attributes ?? {}).filter(([, value]) => value.trim()).slice(0, 8)
  const colors = [...new Set((product?.skus ?? []).map(sku => sku.attributes?.颜色).filter((value): value is string => Boolean(value)))]
  const sizes = [...new Set((product?.skus ?? []).map(sku => sku.attributes?.尺码).filter((value): value is string => Boolean(value)))]
  useEffect(() => setImageIndex(0), [product?.id])
  const sellingPoints = content?.body.sellingPoints ?? []
  const detailModules = (content?.body.modules ?? []).filter(module => !['hero', 'selling_points', 'specifications', 'sku', 'real_images', 'platform'].includes(module.key))
  const moduleKind = (module: NonNullable<ContentVersion['body']['modules']>[number]) => module.contentKind ?? (module.body.startsWith('[待确认]') ? 'pending' : 'fact')
  const visibleModules = detailModules.filter(module => moduleFilter === 'all' || moduleKind(module) === moduleFilter)
  const moduleLabels = { all: '全部', fact: '已确认事实', creative: '创意表达', pending: '待确认' } as const
  return <section className="product-detail-preview" aria-label="商品详情页预览">
    <div className="preview-heading"><div><span className="section-kicker">STOREFRONT PREVIEW</span><h3>商品详情页预览</h3></div><StatusChip tone="blue">草稿 · 未发布</StatusChip></div>
    <div className="storefront-card">
      <div className="storefront-gallery"><div className="gallery-main">{images[imageIndex] ? <img src={images[imageIndex]} alt={`${title}商品主图`} /> : <div className="gallery-empty"><ShoppingBag size={36}/><span>尚未绑定商品图片</span></div>}</div>{images.length > 1 && <div className="gallery-thumbs">{images.slice(0, 5).map((image, index) => <button key={`${index}-${image.slice(0, 24)}`} className={imageIndex === index ? 'active' : ''} onClick={() => setImageIndex(index)} aria-label={`查看商品图 ${index + 1}`}><img src={image} alt={`商品图 ${index + 1} 缩略图`} /></button>)}</div>}</div>
      <div className="storefront-info"><div className="storefront-tags"><span>{platformNames[product?.platform ?? ''] ?? '待选平台'} · {product?.category ?? '品类待确认'}</span><span>{product?.factsConfirmed ? '事实已确认' : '事实待确认'}</span></div><h4>{content?.body.title ?? title}</h4><p className="storefront-subtitle">{content?.body.detail ?? '内容尚未生成；当前只展示已保存的商品事实。'}</p><div className="storefront-price">{typeof product?.price === 'number' && product.price > 0 ? <><span>¥</span><strong>{product.price.toLocaleString()}</strong><em>起</em><small>来自商品事实</small></> : <strong className="price-pending">价格待确认</strong>}</div>{colors.length > 0 && <div className="storefront-spec"><b>颜色</b><div>{colors.map((color, index) => <button key={color} className={index === 0 ? 'selected' : ''}>{color}</button>)}</div></div>}{sizes.length > 0 && <div className="storefront-spec"><b>尺码</b><div>{sizes.map((size, index) => <button key={size} className={index === 0 ? 'selected' : ''}>{size}</button>)}</div></div>}<div className="storefront-benefits"><span>库存 {product?.stock?.toLocaleString() ?? '待确认'}</span><span>{product?.skuCount ?? 0} 个 SKU</span><span>发布前需人工审核</span></div></div>
    </div>
    <div className="detail-sections"><div className="detail-section-head"><span>商品卖点</span><small>{content ? '来自当前内容版本' : '生成后展示'}</small></div>{content ? <div className="selling-point-grid">{sellingPoints.slice(0, 3).map((point, index) => <article key={point}><b>0{index + 1}</b><span>{point}</span></article>)}</div> : <div className="empty-inline">尚未生成商品卖点</div>}<div className="detail-section-head"><span>规格参数</span><small>{product?.category ?? '品类待确认'}</small></div>{attributes.length ? <div className="spec-table">{attributes.map(([key, value]) => <span key={key}><b>{key}</b>{value}</span>)}</div> : <div className="empty-inline">尚未保存可展示参数</div>}{detailModules.length > 0 && <><div className="detail-section-head"><span>完整详情模块</span><small>{visibleModules.length} / {detailModules.length} 个可审阅模块</small></div><div className="module-filter" role="tablist" aria-label="详情模块类型筛选">{(Object.keys(moduleLabels) as Array<keyof typeof moduleLabels>).map(filter => <button key={filter} className={moduleFilter === filter ? 'active' : ''} onClick={() => setModuleFilter(filter)} role="tab" aria-selected={moduleFilter === filter}>{moduleLabels[filter]} <em>{filter === 'all' ? detailModules.length : detailModules.filter(module => moduleKind(module) === filter).length}</em></button>)}</div><div className="detail-module-grid">{visibleModules.map(module => { const kind = moduleKind(module); return <article className={kind === 'pending' ? 'pending' : kind === 'creative' ? 'creative' : ''} key={module.key}><div><b>{module.title}</b><span>{kind === 'pending' ? '待确认 · 待补资料' : kind === 'creative' ? '创意表达' : '已确认事实'}</span></div><p>{module.body}</p>{kind === 'pending' && module.pendingReason && <small>待确认原因：{module.pendingReason}</small>}{module.imageGuidance && <small>配图：{module.imageGuidance}</small>}</article>})}</div>{visibleModules.length === 0 && <div className="empty-inline">当前筛选没有对应模块</div>}</>}<div className="detail-section-head"><span>规则提示</span><small>发布前仍需人工确认</small></div><div className="detail-rule-note"><ShieldCheck size={15}/><span>仅使用上方已保存事实生成内容；标记为“待确认”的材质、性能和功效不得写成确定性卖点。</span></div></div>
  </section>
}

function TaskWorkspace({ openPublish, baseUrl, target, onContext, onSelectTarget, onBack }: { openPublish: () => void; baseUrl?: string; target?: Target; onContext: (context: TaskContext | null) => void; onSelectTarget: (target: Target) => void; onBack: () => void }) {
  const taskListRequestId = useRef(0)
  const [direction, setDirection] = useState(0)
  const [version, setVersion] = useState<'v4' | 'diff'>('v4')
  const [approved, setApproved] = useState(false)
  const [task, setTask] = useState<Task | null>(null)
  const [content, setContent] = useState<ContentVersion | null>(null)
  const [contentVersions, setContentVersions] = useState<ContentVersion[]>([])
  const [reviewTab, setReviewTab] = useState<'findings' | 'versions'>('findings')
  const [findings, setFindings] = useState<ReviewFinding[]>([])
  const [reviewCategories, setReviewCategories] = useState<ReviewCategory[]>([])
  const [feedback, setFeedback] = useState<TaskFeedback[]>([])
  const [feedbackReason, setFeedbackReason] = useState('')
  const [feedbackRating, setFeedbackRating] = useState<FeedbackRating | null>(null)
  const [timeline, setTimeline] = useState<TaskTimelineEvent[]>([])
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [contextCollapsed, setContextCollapsed] = useState(false)
  const [diffChanges, setDiffChanges] = useState<Array<{ path: string; before: unknown; after: unknown }>>([])
  const [requestText, setRequestText] = useState('')
  const [understanding, setUnderstanding] = useState<TaskUnderstanding | null>(null)
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({})
  const [taskList, setTaskList] = useState<Task[] | null>(null)
  const [taskProducts, setTaskProducts] = useState<ApiProduct[]>([])
  const [taskPage, setTaskPage] = useState(0)
  const [product, setProduct] = useState<ApiProduct | null>(null)
  const [taskListError, setTaskListError] = useState('')
  const [taskListLoading, setTaskListLoading] = useState(Boolean(baseUrl))
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [operation, setOperation] = useState('')
  const [error, setError] = useState('')
  const targetProductId = target?.productId
  const targetPlatform = target?.platform ?? 'taobao'
  const targetTitle = target?.title ?? '轻云防晒外套 2026'
  const directions = [
    { id: 'A', title: '展示真实外观', tag: '商品呈现', desc: `突出${product?.attributes?.外观 ?? '已保存商品外观'}和${product?.attributes?.颜色 ?? '已确认配色'}，不扩展未确认性能。`, evidence: '外观事实' },
    { id: 'B', title: '规格信息清晰', tag: '规格说明', desc: `清晰呈现 ${product?.skuCount ?? 0} 个 SKU、价格和库存，方便商家逐项核对。`, evidence: 'SKU 事实' },
    { id: 'C', title: '守住事实边界', tag: '合规表达', desc: '对材质、性能和功效等待确认项保持克制，避免生成误导性卖点。', evidence: '风险最低' },
  ]
  const blockingFindings = findings.filter(item => item.severity === 'error').length
  const warningFindings = findings.filter(item => item.severity === 'warning').length
  const reviewScore = !content ? '—' : blockingFindings ? '—' : '100'
  const generateDraft = (created: Task) => {
    if (!baseUrl) return Promise.reject(new Error('API 未配置'))
    if (!['direction_selected', 'plan_confirmed'].includes(created.state)) return Promise.reject(new Error('请先选择创意方向并确认制作方案'))
    return (created.state === 'plan_confirmed' ? Promise.resolve(created) : confirmTaskPlan(baseUrl, created.id, created.version)).then(confirmed => generateContent(baseUrl, confirmed.id).then(draft => ({ task: confirmed, draft })))
  }
  useEffect(() => {
    if (!baseUrl || !targetProductId || !target) {
      setLoading(false)
      if (baseUrl) setError('请先从商品列表选择一个真实商品，再创建营销任务。')
      return
    }
    let cancelled = false
    setLoading(true); setError(''); setOperation(target.taskId ? '恢复原任务…' : '创建任务…'); setTask(null); setProduct(null); setApproved(false); setContent(null); setContentVersions([]); setFindings([]); setReviewCategories([]); setReviewTab('findings'); onContext(null)
    const restore = async () => {
      const targetIdentityError = validateTargetStoreIdentity(target)
      if (targetIdentityError) throw new Error(targetIdentityError)
      const items = await fetchProducts(baseUrl)
      const selectedProduct = items.find(item => item.id === targetProductId)
      if (!selectedProduct) throw new Error('所选商品已不在当前工作区商品列表中，已阻止继续操作。请返回商品列表重新选择。')
      const productIdentityError = validateProductStoreIdentity(target, selectedProduct)
      if (productIdentityError) throw new Error(productIdentityError)
      if (!cancelled) setProduct(selectedProduct)
      const current = target.taskId
        ? await fetchTask(baseUrl, target.taskId)
        : await createTask(baseUrl, { product_id: targetProductId, platform: targetPlatform, account_id: target.accountId })
      const taskIdentityError = validateTaskStoreIdentity(target, current)
      if (taskIdentityError) throw new Error(taskIdentityError)
      return current
    }
    restore()
      .then(async current => {
        if (cancelled) return null
        setTask(current)
        setApproved(['approved', 'publish_prepared', 'publishing', 'delivered'].includes(current.state))
        setDirection(Math.max(0, directions.findIndex(item => item.id === current.selectedDirectionId)))
        if (current.missingQuestions?.length) setUnderstanding({ requestText: current.requestText ?? '', platformCandidates: [current.platform], productCandidates: [], extracted: {}, questions: current.missingQuestions, executionPlan: { mode: 'single_task', canCreate: true, reason: '当前任务已绑定单一平台商品', childTasks: [{ platform: current.platform, candidateProductIds: [current.productId], bindingState: 'ready' }] } })
        if (!target.taskId) return null
        const [versions, nextFeedback, nextTimeline] = await Promise.all([fetchContentVersions(baseUrl, current.id), fetchTaskFeedback(baseUrl, current.id).catch(() => []), fetchTaskTimeline(baseUrl, current.id).catch(() => [])])
        if (cancelled) return null
        setFeedback(nextFeedback); setTimeline(nextTimeline); setContentVersions(versions.slice().sort((left, right) => right.version - left.version))
        const restored = versions.slice().sort((left, right) => right.version - left.version)[0] ?? null
        if (!restored) return null
        setContent(restored); onContext({ task: current, version: restored })
        return reviewContent(baseUrl, restored.id)
      })
      .then(result => { if (!cancelled && result) { setFindings(result.findings); setReviewCategories(result.categories) } })
      .catch(cause => { if (!cancelled) setError(describeApiError(cause)) })
      .finally(() => { if (!cancelled) { setLoading(false); setOperation('') } })
    return () => { cancelled = true }
  }, [baseUrl, targetProductId, targetPlatform, target])
  const loadTaskList = () => {
    const requestId = ++taskListRequestId.current
    if (!baseUrl || target) { setTaskListLoading(false); return }
    setTaskListLoading(true); setTaskListError(''); setTaskList(null)
    Promise.all([fetchTasks(baseUrl), fetchProducts(baseUrl)])
      .then(([tasks, products]) => { if (requestId === taskListRequestId.current) { setTaskList(tasks.slice().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))); setTaskProducts(products); setTaskPage(0) } })
      .catch(cause => { if (requestId === taskListRequestId.current) setTaskListError(describeApiError(cause)) })
      .finally(() => { if (requestId === taskListRequestId.current) setTaskListLoading(false) })
  }
  useEffect(() => { loadTaskList() }, [baseUrl, target])
  const chooseDirection = (index: number, id: string) => {
    setDirection(index)
    if (!baseUrl || !task) return
    setOperation('方向保存中…'); setError('')
    selectDirection(baseUrl, task.id, id).then(setTask).catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const regenerate = () => {
    if (!baseUrl || !task || content) return
    setApproved(false)
    setOperation('生成内容中…'); setError('')
    generateDraft(task).then(({ task: confirmed, draft }) => reviewContent(baseUrl, draft.id).then(result => ({ confirmed, draft, result }))).then(({ confirmed, draft, result }) => { setTask(confirmed); setContent(draft); setContentVersions(current => [draft, ...current.filter(item => item.id !== draft.id)]); setFindings(result.findings); setReviewCategories(result.categories); setVersion('v4'); setReviewTab('findings'); onContext({ task: confirmed, version: draft }) }).catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const showDiff = () => {
    if (!baseUrl || !content) { setVersion('diff'); return }
    setOperation('读取版本差异…')
    fetchContentVersions(baseUrl, content.taskId).then(versions => versions.find(candidate => candidate.version === content.version - 1)).then(previous => diffContentVersions(baseUrl, content.id, previous?.id)).then(result => { setDiffChanges(result?.changes ?? []); setVersion('diff') }).catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const viewVersion = (item: ContentVersion) => {
    setContent(item); setVersion('v4'); setReviewTab('findings')
    if (!baseUrl) return
    setOperation('读取版本检查…'); setError('')
    reviewContent(baseUrl, item.id).then(result => { setFindings(result.findings); setReviewCategories(result.categories); if (task) onContext({ task, version: item }) }).catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const approve = (checked: boolean) => {
    if (!checked || !baseUrl || !task || !content) { setApproved(checked); return }
    setOperation('批准中…'); setError('')
    approveContent(baseUrl, task.id, content.id).then(result => { setTask(result.task); setContent(result.version); setContentVersions(current => [result.version, ...current.filter(item => item.id !== result.version.id)]); setApproved(true); setFindings([]); setReviewTab('findings'); onContext({ task: result.task, version: result.version }) }).catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const sendFeedback = (rating: FeedbackRating) => {
    setFeedbackRating(rating)
    if (!baseUrl || !task) return
    setOperation('反馈提交中…'); setError('')
    submitTaskFeedback(baseUrl, task.id, { rating, ...(content?.id ? { content_version_id: content.id } : {}), ...(feedbackReason.trim() ? { reason: feedbackReason.trim() } : {}) })
      .then(item => { setFeedback(current => [item, ...current]); fetchTaskTimeline(baseUrl, task.id).then(setTimeline).catch(() => undefined) })
      .catch(cause => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const decideFinding = (finding: ReviewFinding, status: 'acknowledged' | 'waived') => {
    if (!baseUrl || !content || finding.priority === 'P0') return
    const reason = status === 'waived' ? window.prompt('请说明接受该建议风险的原因；该原因会进入审核记录。', '')?.trim() : undefined
    if (status === 'waived' && !reason) return
    setOperation(status === 'waived' ? '保存接受理由中…' : '保存知悉状态中…'); setError('')
    decideReviewFinding(baseUrl, content.id, { code: finding.code, field: finding.field, status, ...(reason ? { reason } : {}), expected_revision: content.revision })
      .then(result => { setContent(result.version); setFindings(result.report.findings); setReviewCategories(result.report.categories); if (task) onContext({ task, version: result.version }) })
      .catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const understand = () => {
    if (!baseUrl || !requestText.trim()) return
    setOperation('分析任务需求中…'); setError('')
    understandTask(baseUrl, requestText.trim()).then(setUnderstanding).catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const submitAnswer = (question: TaskQuestion) => {
    const answerValue = questionAnswers[question.id]?.trim() ?? ''
    if (!baseUrl || !task || (question.id !== 'confirm_facts' && !answerValue)) return
    const value = question.id === 'confirm_facts' ? true : /^\d+$/u.test(answerValue) && question.id === 'output_count' ? Number(answerValue) : answerValue
    setOperation('保存补充信息中…'); setError('')
    answerTask(baseUrl, task.id, { [question.id]: value }, task.version)
      .then(next => { setTask(next); setUnderstanding(current => current ? { ...current, questions: next.missingQuestions ?? [] } : current); setQuestionAnswers(current => ({ ...current, [question.id]: '' })) })
      .catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const deferQuestion = (question: TaskQuestion) => {
    if (!baseUrl || !task || question.kind === 'blocking') return
    setOperation('暂存问题中…'); setError('')
    answerTask(baseUrl, task.id, { defer_questions: [question.id] }, task.version)
      .then(next => { setTask(next); setUnderstanding(current => current ? { ...current, questions: next.missingQuestions ?? [] } : current) })
      .catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const editTitle = () => {
    if (!baseUrl || !content) return
    const nextTitle = window.prompt('请输入新的首屏标题', content.body.title)?.trim()
    if (!nextTitle || nextTitle === content.body.title) return
    setOperation('创建修改版本中…'); setError('')
    modifyContentVersion(baseUrl, content.id, { changes: { title: nextTitle }, locked_fields: ['price', 'stock', 'sku'], reason: 'merchant_studio_title_edit' })
      .then(result => { setTask(result.task); setContent(result.version); setContentVersions(current => [result.version, ...current.filter(item => item.id !== result.version.id)]); setApproved(false); setFindings([]); setReviewTab('findings'); onContext({ task: result.task, version: result.version }) })
      .catch(cause => setError(describeApiError(cause))).finally(() => setOperation(''))
  }
  const taskStateLabel = (state: string) => ({ draft: '待补充信息', ready_for_direction: '待选创意方向', direction_selected: '待确认制作方案', plan_confirmed: '待生成内容', generating: '内容生成中', review_required: '待审核', changes_requested: '待修改', approved: '已批准', publish_prepared: '待确认发布', publishing: '发布处理中', delivered: '已交付', failed_recoverable: '可重试', failed_terminal: '处理失败', canceled: '已取消' }[state] ?? '处理中')
  const taskPageSize = 12
  const taskPageCount = Math.max(1, Math.ceil((taskList?.length ?? 0) / taskPageSize))
  const visibleTasks = taskList?.slice(taskPage * taskPageSize, (taskPage + 1) * taskPageSize) ?? []
  if (!target) return <div className="page-stack"><section className="page-intro"><div><span className="section-kicker">TASK QUEUE</span><h2>营销任务</h2><p>从这里恢复已有任务；只有从商品页点击“创建任务”才会新建任务。</p></div><StatusChip tone="blue">{taskListLoading ? '读取中…' : taskListError ? '读取失败' : `${taskList?.length ?? 0} 个任务`}</StatusChip></section>{taskListLoading && <LoadingState label="正在读取营销任务…" />}{taskListError && !taskListLoading && <ErrorNotice message={taskListError} onRetry={loadTaskList} />}{!baseUrl && <div className="info-notice"><CircleHelp size={16} />配置 API 后可读取真实任务列表。</div>}{!taskListLoading && !taskListError && Boolean(taskList?.length) && <section className="panel task-list-panel">{visibleTasks.map(item => { const itemProduct = taskProducts.find(candidate => candidate.id === item.productId); const identityTarget = { accountId: item.accountId, storeName: itemProduct?.storeName }; const identityError = itemProduct ? validateProductStoreIdentity(identityTarget, itemProduct) ?? validateTaskStoreIdentity(identityTarget, item) : '商品及店铺信息尚未恢复，已阻止恢复任务。'; const label = item.missingQuestions?.length ? '待补充信息' : taskStateLabel(item.state); return <div className="task-list-row" key={item.id}><div><b>{itemProduct?.title ?? '商品信息待恢复'} · {platformNames[item.platform]} · {itemProduct?.storeName ?? '店铺待恢复'}</b><span>{item.accountId ? `账号 ${item.accountId} · ` : ''}{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })} · 内容版本 v{item.version}</span></div><StatusChip tone={identityError || ['failed_recoverable', 'failed_terminal'].includes(item.state) || item.missingQuestions?.length ? 'amber' : ['approved', 'delivered'].includes(item.state) ? 'green' : 'blue'}>{identityError ? '店铺身份异常' : label}</StatusChip><button className="text-button" onClick={() => itemProduct && onSelectTarget({ productId: item.productId, platform: item.platform, title: itemProduct.title, accountId: item.accountId, storeName: itemProduct.storeName, taskId: item.id })} disabled={Boolean(identityError)} title={identityError ?? undefined}>恢复任务 <ArrowRight size={14} /></button></div>})}<div className="task-list-pagination"><span>第 {taskPage + 1} / {taskPageCount} 页</span><div><button onClick={() => setTaskPage(page => Math.max(0, page - 1))} disabled={taskPage === 0}>上一页</button><button onClick={() => setTaskPage(page => Math.min(taskPageCount - 1, page + 1))} disabled={taskPage >= taskPageCount - 1}>下一页</button></div></div></section>}{!taskListLoading && !taskListError && taskList !== null && taskList.length === 0 && <div className="empty-state"><Sparkles size={22} /><b>暂无营销任务</b><span>从商品与资产选择商品即可创建任务。</span></div>}</div>
  return <div className="task-shell">
    {timelineOpen && <div className="modal-layer" role="dialog" aria-modal="true" aria-label="任务历史"><div className="modal timeline-modal"><div className="modal-head"><div className="modal-icon"><History size={18} /></div><div><span className="section-kicker">AUDIT TRAIL</span><h2>任务历史</h2></div><button className="icon-button" onClick={() => setTimelineOpen(false)} aria-label="关闭任务历史"><X size={18} /></button></div><div className="modal-body timeline-list">{timeline.length ? timeline.slice().reverse().map(event => <div className="timeline-row" key={event.id}><span className={`timeline-dot ${event.delivery === 'unknown' ? 'unknown' : event.delivery === 'delivered' ? 'delivered' : ''}`} /><div><b>{event.event_type}</b><span>序列 {event.sequence} · {event.delivery === 'unknown' ? '待对账' : event.delivery === 'delivered' ? '已记录' : '处理中'}</span></div><time>{new Date(event.occurred_at).toLocaleString('zh-CN', { hour12: false })}</time></div>) : <div className="empty-state"><History size={18} />暂无可用历史事件</div>}</div></div></div>}
    <div className="task-titlebar"><div><button className="back-link" onClick={onBack}><ArrowRight size={16} />所有任务</button><h2>{targetTitle} · {platformNames[targetPlatform]} · {target.storeName ?? '店铺身份缺失'}</h2><div className="task-meta"><StatusChip tone={approved ? 'green' : 'blue'}>{approved ? '已批准' : loading ? '准备中' : taskStateLabel(task?.state ?? '')}</StatusChip><span>{target.accountId ? `账号 ${target.accountId}` : '账号 ID 缺失'}</span><span>内容版本 v{content?.version ?? 0}</span><span>{operation || '已保存'}</span></div></div><div className="button-row compact"><button className="secondary" onClick={() => { if (baseUrl && task) fetchTaskTimeline(baseUrl, task.id).then(setTimeline).catch(() => undefined); setTimelineOpen(true) }} disabled={!task}><History size={16} />历史</button><button className="primary" disabled={!approved || Boolean(operation) || Boolean(error)} onClick={openPublish}><Rocket size={16} />进入发布</button></div></div>
    {loading && <LoadingState label={operation || '正在创建任务…'} />}
    {error && <ErrorNotice message={error} onRetry={() => window.location.reload()} />}
    <section className="panel task-understanding-panel">
      <div className="panel-heading"><div><span className="section-kicker">TASK UNDERSTANDING</span><h3>先确认需求与阻断问题</h3></div><StatusChip tone={understanding?.questions.length ? 'amber' : 'green'}>{understanding?.questions.length ? `${understanding.questions.length} 项待补充` : '可继续执行'}</StatusChip></div>
      <div className="understanding-form"><input value={requestText} onChange={event => setRequestText(event.target.value)} placeholder="例如：把这件商品同步到淘宝和拼多多，主推防晒卖点" disabled={Boolean(operation)} /><button className="secondary" onClick={understand} disabled={!baseUrl || !requestText.trim() || Boolean(operation)}>分析需求</button></div>
      {understanding && <div className="understanding-result"><span>识别平台：{understanding.platformCandidates.map(platform => platformNames[platform]).join('、') || '待确认'} · 目标：{understanding.extracted.goal ?? '待补充'}</span><div data-testid="task-execution-plan" className="task-execution-plan"><div><b>{understanding.executionPlan.mode === 'split_by_platform' ? `将拆成 ${understanding.executionPlan.childTasks.length} 个独立平台子任务` : understanding.executionPlan.mode === 'single_task' ? '单平台独立任务' : '等待明确平台'}</b><small>{understanding.executionPlan.reason}</small></div><div className="execution-child-grid">{understanding.executionPlan.childTasks.map(child => <article key={child.platform}><StatusChip tone={child.bindingState === 'ready' ? 'green' : 'amber'}>{platformNames[child.platform]}</StatusChip><b>{child.bindingState === 'ready' ? '商品已唯一绑定' : child.bindingState === 'ambiguous' ? `${child.candidateProductIds.length} 个候选，需选择` : '缺少该平台商品'}</b><small>{child.bindingState === 'ready' ? child.candidateProductIds[0] : '不会复用其他平台商品'}</small></article>)}</div></div>{understanding.productCandidates.length > 0 && <div className="understanding-candidates" aria-label="商品候选"><small>检测到多个候选时，请直接选择一个稳定商品：</small>{understanding.productCandidates.map(candidate => <article key={candidate.id}><button data-testid={`task-product-candidate-${candidate.id}`} className="candidate-choice" onClick={() => setQuestionAnswers(current => ({ ...current, product_id: candidate.id }))}><b>{candidate.title}</b><span>{platformNames[candidate.platform]} · {candidate.id}</span></button></article>)}</div>}{understanding.questions.map(question => <div className="question-row" key={question.id}><div><b>{question.prompt}</b><small>{question.kind === 'blocking' ? '阻断项，完成前不能继续' : question.kind === 'recommended' ? '建议补充，可使用默认值' : '可选信息'}</small><small>为什么问：{question.why}</small><small>不回答：{question.ifSkipped}</small></div><div className="question-answer">{question.id === 'platform_product_bindings' ? <button className="secondary" onClick={onBack}>返回商品列表分别选择</button> : question.id === 'confirm_facts' ? <button className="secondary" onClick={() => submitAnswer(question)} disabled={Boolean(operation)}>确认商品事实准确</button> : <><input value={questionAnswers[question.id] ?? ''} onChange={event => setQuestionAnswers(current => ({ ...current, [question.id]: event.target.value }))} placeholder="请输入答案" /><button className="text-button" onClick={() => submitAnswer(question)} disabled={Boolean(operation) || !(questionAnswers[question.id]?.trim())}>保存</button>{question.kind !== 'blocking' && <button className="text-button" onClick={() => deferQuestion(question)} disabled={Boolean(operation)}>稍后补充</button>}</>}</div></div>)}</div>}
    </section>
    <div className="workflow-stepper" aria-label="任务进度"><div className="complete"><span><Check size={13} /></span><b>事实确认</b></div><i /><div className="complete"><span><Check size={13} /></span><b>方向选择</b></div><i /><div className="current"><span>3</span><b>内容审核</b></div><i /><div><span>4</span><b>确认发布</b></div></div>
    <div className="workspace-grid">
      <aside className={`context-panel ${contextCollapsed ? 'collapsed' : ''}`}>
        <div className="context-head"><span className="section-kicker">SOURCE OF TRUTH</span><h3>任务事实</h3><button className="icon-button" onClick={() => setContextCollapsed(current => !current)} aria-expanded={!contextCollapsed} aria-label={contextCollapsed ? '展开事实面板' : '收起事实面板'}><PanelLeftClose size={17} /></button></div>
        <div className="context-product"><div className="product-visual"><ShoppingBag size={32} /></div><div><StatusChip tone={platformTone[targetPlatform]}>{platformNames[targetPlatform]}</StatusChip><b>{targetTitle}</b><span>{target.storeName && target.accountId ? storeIdentityLabel(target) : '店铺身份缺失，已阻止继续操作'}</span><span>{target?.remoteId ? `远端商品 ${target.remoteId}` : '等待平台商品标识'}</span></div></div>
        <div className="context-section"><div className="subhead"><b>关键事实</b><StatusChip tone={product?.factsConfirmed ? 'green' : 'amber'}>{product?.factsConfirmed ? '已确认' : '待确认'}</StatusChip></div>{Object.entries(product?.attributes ?? {}).slice(0, 6).map(([key, value]) => <div className="fact-row" key={key}><span>{key}</span><b>{value}</b><small><Link2 size={11} />商品事实库</small></div>)}{!Object.keys(product?.attributes ?? {}).length && <div className="empty-inline">尚未读取商品属性</div>}</div>
        <div className="context-section"><div className="subhead"><b>约束与规则</b><span>4 条</span></div><div className="constraint"><ShieldCheck size={16} /><div><b>不得表述“100% 防晒”</b><span>广告法规则包 · v1.2</span></div></div><div className="constraint"><PackageSearch size={16} /><div><b>不修改价格与库存</b><span>本次任务锁定范围</span></div></div></div>
      </aside>

      <main className="editor-panel">
        <section className="direction-section"><div className="section-heading-inline"><div><span className="section-kicker">CREATIVE DIRECTIONS</span><h3>3 个事实安全方向</h3></div><button className="text-button" onClick={regenerate} disabled={Boolean(operation) || !baseUrl || Boolean(content) || !task?.selectedDirectionId || !['direction_selected', 'plan_confirmed'].includes(task.state)}><RefreshCw size={14} className={operation === '生成内容中…' ? 'spin' : undefined} />{operation === '生成内容中…' ? '生成中…' : content ? '内容已生成' : '确认制作方案并生成'}</button></div><div className="direction-grid">{directions.map((item, index) => <button key={item.id} className={`direction-card ${direction === index && task?.selectedDirectionId === item.id ? 'selected' : ''}`} onClick={() => chooseDirection(index, item.id)} aria-pressed={direction === index && task?.selectedDirectionId === item.id} disabled={Boolean(operation) || Boolean(content)}><div><span className="direction-letter">{item.id}</span><StatusChip tone="neutral">{item.tag}</StatusChip>{direction === index && task?.selectedDirectionId === item.id && <span className="selected-check"><Check size={13} /></span>}</div><h4>{item.title}</h4><p>{item.desc}</p><small>依据 <b>{item.evidence}</b></small></button>)}</div>{task?.selectedDirectionId && !content && <div className="plan-confirmation-note"><ShieldCheck size={16}/><span>制作方案：生成当前平台详情页和静态素材 Brief；锁定价格、库存与 SKU。点击“确认制作方案并生成”后才会产生生成任务。</span></div>}</section>
        <section className="content-document">
          <div className="document-toolbar"><div><span className="section-kicker">CONTENT DRAFT</span><h3>详情页内容草稿</h3></div><div className="segmented"><button className={version === 'v4' ? 'active' : ''} onClick={() => setVersion('v4')}>v{content?.version ?? 0} 当前版</button><button className="text-button" onClick={editTitle} disabled={!content || Boolean(operation)}>局部修改</button><button className={version === 'diff' ? 'active' : ''} onClick={showDiff} disabled={!content || Boolean(operation)}><ArrowLeftRight size={13} />与上一版比较</button></div></div>
          <ProductDetailPreview content={content} title={targetTitle} product={product} />
          {version === 'v4' ? <div className="document-body"><div className="doc-label">首屏标题</div><h4>{content?.body.title ?? '等待内容版本'}</h4><p>{content?.body.detail ?? '选择商品并生成内容版本后，这里显示真实草稿。'}</p><div className="source-note"><Link2 size={13} />引用 {content?.factVersionIds.length ?? 0} 条已确认事实 · 未使用推断值</div><div className="doc-label">核心卖点</div><ul>{(content?.body.sellingPoints ?? []).map(point => <li key={point}><span>{point}</span></li>)}</ul>{content?.body.brief && <div className="brief-card"><div className="doc-label">静态素材 Brief</div><p><b>{content.body.brief.placement}</b> · {content.body.brief.targetDimensions}</p><p>{content.body.brief.headline}｜{content.body.brief.subheadline}</p><p>核心卖点：{content.body.brief.coreSellingPoint} · CTA：{content.body.brief.cta}</p><small>安全区：{content.body.brief.safeArea} · 禁止修改：{content.body.brief.protectedAreas.join('、')}</small></div>}</div> : <div className="diff-view">{diffChanges.length ? diffChanges.map(change => <div className="diff-line added" key={change.path}><span>+</span><p><b>{change.path}</b>：{String(change.after ?? '')}</p></div>) : <div className="diff-line"><span>·</span><p>暂无服务端差异或没有上一版本</p></div>}<div className="diff-summary"><CheckCircle2 size={17} />版本差异来自服务端内容版本 API</div></div>}
        </section>
      </main>

      <aside className="review-panel">
        <div className="review-score"><div className="score-ring" style={{ background: `conic-gradient(var(--green) 0 ${content && !blockingFindings ? 100 : 0}%,#e3e8e4 ${content && !blockingFindings ? 100 : 0}%)` }}><strong>{reviewScore}</strong><span>/100</span></div><div><span className="section-kicker">REVIEW SCORE</span><h3>{!content ? '等待内容版本' : blockingFindings ? '存在阻断项' : '可以进入人工确认'}</h3><p>{blockingFindings} 项阻断 · {warningFindings} 项建议</p></div></div>
        <div className="review-category-list">{reviewCategories.map(category => <div className={`review-category ${category.status}`} key={category.id}><span>{category.status === 'passed' ? <CheckCircle2 size={14}/> : category.status === 'blocking' ? <AlertCircle size={14}/> : <CircleHelp size={14}/>}</span><div><b>{category.name}</b><small>{category.summary}</small></div></div>)}</div>
        <div className="review-tabs"><button className={reviewTab === 'findings' ? 'active' : ''} onClick={() => setReviewTab('findings')}>检查结果 <em>{findings.length}</em></button><button className={reviewTab === 'versions' ? 'active' : ''} onClick={() => setReviewTab('versions')}>版本记录 <em>{contentVersions.length}</em></button></div>
        {reviewTab === 'findings' ? <div className="finding-list">{findings.length ? findings.map(finding => { const evidenceLabel = reviewEvidenceLabel(finding); return <article className={`finding ${finding.severity === 'error' ? 'warning' : 'info'}`} key={`${finding.code}-${finding.field}`}><div><AlertCircle size={17} /><b>{finding.priority} · {finding.severity === 'error' ? '阻断' : finding.status === 'waived' ? '已接受' : finding.status === 'acknowledged' ? '已知悉' : '建议'} · {reviewFieldLabel(finding.field)}</b></div><p>{finding.message}</p>{evidenceLabel && <small>{evidenceLabel}</small>}<small>建议：{finding.repairSuggestion}</small>{finding.decision && <small>处理记录：{finding.decision.reason}</small>}{finding.severity === 'warning' && finding.status === 'open' && <div className="finding-actions"><button onClick={() => decideFinding(finding, 'acknowledged')} disabled={Boolean(operation)}>标记已知悉</button><button onClick={() => decideFinding(finding, 'waived')} disabled={Boolean(operation)}>带理由接受</button></div>}</article> }) : <div className="empty-state"><CheckCircle2 size={18} />{content ? '服务端检查通过，暂无发现项' : '生成内容后显示检查结果'}</div>}</div> : <div className="version-list">{contentVersions.length ? contentVersions.map(item => <article className={`version-row ${item.id === content?.id ? 'current' : ''}`} key={item.id}><div><b>内容版本 v{item.version}</b><span>{item.id === content?.id ? '当前版本' : '历史版本'} · {item.state} · 引用事实 {item.factVersionIds.length} 条 · 规则 {item.ruleVersionIds.length} 条</span></div><button className="text-button" onClick={() => viewVersion(item)}>查看版本</button></article>) : <div className="empty-state"><History size={18} />当前任务暂无内容版本</div>}</div>}
        <div className="feedback-section"><div className="subhead"><b>交付反馈</b><span>仅用于当前任务分析</span></div><p className="feedback-hint">内容交付后告诉我们效果，不会自动修改全局规则。</p><div className="feedback-actions"><button className={feedbackRating === 'liked' ? 'selected' : ''} onClick={() => sendFeedback('liked')} disabled={Boolean(operation) || !task || !content}>满意</button><button className={feedbackRating === 'neutral' ? 'selected' : ''} onClick={() => sendFeedback('neutral')} disabled={Boolean(operation) || !task || !content}>一般</button><button className={feedbackRating === 'needs_improvement' ? 'selected' : ''} onClick={() => sendFeedback('needs_improvement')} disabled={Boolean(operation) || !task || !content}>需改进</button></div><input className="feedback-input" value={feedbackReason} onChange={event => setFeedbackReason(event.target.value)} placeholder="可选：补充原因" maxLength={2000} disabled={!content} />{feedback.length > 0 && <small className="feedback-count">已记录 {feedback.length} 条任务反馈</small>}</div>
        <div className="approval-box"><label><input type="checkbox" checked={approved} onChange={e => approve(e.target.checked)} disabled={Boolean(operation) || loading || approved || !content} /><span><b>我已核对事实、规则和最终内容</b><small>{content ? `批准后会锁定内容 v${content.version}；发布仍需二次确认。` : '生成并检查内容后才可批准。'}</small></span></label><button className="primary wide" disabled={!approved || Boolean(operation) || !content} onClick={openPublish}>{operation === '批准中…' ? '批准中…' : approved ? '继续确认发布' : '勾选后批准内容'}<ArrowRight size={16} /></button></div>
      </aside>
    </div>
  </div>
}

function PublishCenter({ openPublish, openCorrection, baseUrl, canOpenPublish }: { openPublish: () => void; openCorrection: (job: PublishJob) => void; baseUrl?: string; canOpenPublish: boolean }) {
  const [jobs, setJobs] = useState<PublishJob[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!baseUrl) { setLoading(false); setJobs(null); setError(''); return }
    let cancelled = false
    let inFlight = false
    const load = (showLoading: boolean) => {
      if (inFlight) return
      inFlight = true
      if (showLoading) { setLoading(true); setJobs(null) }
      setError('')
      fetchPublishJobs(baseUrl)
        .then(next => { if (!cancelled) setJobs(next.slice().sort((left, right) => Number(right.state === 'rejected') - Number(left.state === 'rejected') || Date.parse(right.createdAt) - Date.parse(left.createdAt))) })
        .catch(cause => { if (!cancelled) setError(describeApiError(cause)) })
        .finally(() => { inFlight = false; if (!cancelled && showLoading) setLoading(false) })
    }
    load(true)
    const timer = window.setInterval(() => load(false), 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [baseUrl, reloadKey])
  const statusLabel = (state: string) => ({ queued: '排队中', submitted: '平台已受理', reviewing: '平台审核中', published: '已生效', rejected: '平台驳回', unknown: '待对账', manual_attention: '需人工处理' }[state] ?? state)
  const statusTone = (state: string) => state === 'published' ? 'green' : ['rejected', 'unknown', 'manual_attention'].includes(state) ? 'amber' : 'blue'
  const listReady = !loading && !error && jobs !== null
  return <div className="page-stack"><section className="page-intro"><div><span className="section-kicker">CONTROLLED WRITES</span><h2>每一次线上变更都有确认和回执</h2><p>“平台已受理”不等于“已生效”。未知状态先对账，不盲目重复提交。</p></div><button className="primary" onClick={openPublish} disabled={!baseUrl || !canOpenPublish}><Rocket size={17} />进入已审核任务发布</button></section>{error && !loading && <ErrorNotice message={error} onRetry={() => setReloadKey(key => key + 1)} />}{!baseUrl && <div className="info-notice" role="status"><CircleHelp size={16} />离线演示不会伪造真实平台回执。</div>}{baseUrl && !canOpenPublish && <div className="info-notice" role="status"><CircleHelp size={16} />请先在商品与资产中选择商品并完成内容审核。</div>}<section className="publish-board" aria-busy={loading}><div className="panel"><div className="panel-heading"><div><span className="section-kicker">IN FLIGHT</span><h3>进行中的发布</h3></div><StatusChip tone="blue">{loading ? '读取中…' : error ? '读取失败' : `${jobs?.length ?? 0} 个任务`}</StatusChip></div>{loading && <LoadingState label="正在读取发布任务…" />}{listReady && Boolean(jobs.length) && jobs.map(job => <div className={`publish-job ${job.state === 'rejected' ? 'has-rejection' : ''}`} key={job.id}><div className={`platform-logo ${platformTone[job.platform] ?? 'blue'}`}>{(platformNames[job.platform] ?? job.platform).slice(0, 1)}</div><div><b>{platformNames[job.platform] ?? job.platform} · 发布任务</b><span>{new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}</span></div><StatusChip tone={statusTone(job.state)}>{job.state === 'published' ? <Check size={12} /> : job.state === 'rejected' ? <X size={12}/> : <Clock3 size={12} />}{statusLabel(job.state)}</StatusChip>{job.state === 'rejected' && <div className="publish-rejection"><div><b>平台拒绝码：{job.rejection?.rawCode ?? '平台未返回代码'}</b><p>{job.rejection?.message ?? '平台未返回可读原因，请联系平台支持并提供发布任务时间。'}</p>{job.rejection?.fields.map(field => <span key={`${field.path}-${field.rawCode ?? ''}`}>需修改：{platformFieldLabel(field.path)} · {field.message}{field.rawCode ? `（${field.rawCode}）` : ''}</span>)}</div><button className="secondary correction-button" onClick={() => openCorrection(job)}>定位并修正 <ArrowRight size={14}/></button><small>修正后会生成新版本，必须重新审核、批准并确认发布；系统不会自动重发。</small></div>}</div>)}{listReady && jobs.length === 0 && <div className="empty-state"><PackageSearch size={22} /><b>暂无真实发布任务</b><span>完成内容审核后，发布任务会显示在这里。</span></div>}</div><div className="panel receipt-panel"><div className="panel-heading"><div><span className="section-kicker">RECEIPTS</span><h3>最近回执</h3></div></div>{loading && <LoadingState label="正在读取平台回执…" />}{listReady && Boolean(jobs.length) && jobs.slice(0, 5).map(job => <div className="receipt-row" key={`receipt-${job.id}`}><span className={`receipt-icon ${job.state === 'rejected' ? 'fail' : ''}`}>{job.state === 'rejected' ? <X size={14}/> : <Check size={14}/>}</span><b>{platformNames[job.platform] ?? job.platform} · {statusLabel(job.state)}</b><span>{job.rejection?.rawCode ?? job.remoteState ?? '等待观测'}</span></div>)}{listReady && jobs.length === 0 && <div className="empty-state"><span>暂无回执</span></div>}</div></section></div>
}

function Rules({ baseUrl }: { baseUrl?: string }) {
  const [rulePacks, setRulePacks] = useState<RulePack[]>([])
  const [remoteCategories, setRemoteCategories] = useState<CatalogCategory[]>([])
  const [tab, setTab] = useState<'rules' | 'categories'>('rules')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [selectedCategory, setSelectedCategory] = useState<CatalogCategory | null>(null)
  useEffect(() => { if (baseUrl) fetchRulePacks(baseUrl, platform === 'all' ? undefined : platform).then(setRulePacks).catch(() => setRulePacks([])) }, [baseUrl, platform])
  useEffect(() => { if (baseUrl) fetchCatalogCategories(baseUrl).then(setRemoteCategories).catch(() => setRemoteCategories([])) }, [baseUrl])
  const fallbackRows: RulePack[] = [['中国电商广告表达','cn-commerce-1.0.0','全平台','今天'],['服装鞋包事实完整性','apparel-1.0.0','全平台','2 天前'],['淘宝/天猫字段映射','tmall-apparel-1.0.0','淘宝/天猫','5 天前'],['京东商品写入策略','jd-apparel-write-1.0.0','京东','7 天前']].map((row, index) => ({ id: String(index), name: row[0], version: row[1], scope: row[2], status: 'active', updatedAt: row[3] }))
  const rows: RulePack[] = rulePacks.length ? rulePacks : fallbackRows
  const categories: CatalogCategory[] = remoteCategories.length ? remoteCategories : [
    { name: '服装 / 防晒外套', code: '1312', fields: ['材质、成分、重量、尺码、颜色、功能依据'], platforms: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'], status: 'active', updatedAt: '今天' },
    { name: '鞋靴 / 户外鞋', code: '1408', fields: ['鞋面材质、闭合方式、适用场景、尺码'], platforms: ['jd', 'taobao', 'pinduoduo'], status: 'active', updatedAt: '昨天' },
    { name: '运动 / 速干裤装', code: '1503', fields: ['面料、版型、弹性、洗护、尺码'], platforms: ['taobao', 'tmall'], status: 'active', updatedAt: '3 天前' },
  ]
  const categorySource = remoteCategories.length ? '已连接 API · 管理员发布数据' : baseUrl ? 'API 暂无数据 · 当前展示安全演示类目' : '离线演示类目'
  const platformRows = platform === 'all' ? rows : rows.filter(row => row.scope.includes('全平台') || row.scope.includes(platformNames[platform]))
  const filteredRules = platformRows.filter(row => `${row.name}${row.scope}${row.version}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const filteredCategories = categories.filter(row => `${row.name}${row.code}${row.fields.join('')}`.includes(query))
  const attributeTemplateCount = new Set(categories.flatMap(category => category.fields)).size
  const mappingStatus = baseUrl ? '实时读取' : '未读取'
  return <div className="page-stack"><section className="page-intro"><div><span className="section-kicker">POLICY & TAXONOMY</span><h2>规则库与品类库</h2><p>先选对品类，再按平台规则生成内容；每条规则都能追溯版本、适用范围和阻断原因。</p></div><StatusChip tone="neutral"><ShieldCheck size={15}/>只读证据中心</StatusChip></section><div className="info-notice" role="status"><ShieldCheck size={16}/>规则库负责表达、事实和发布前检查；品类库负责属性模板、平台字段映射和必填项。当前商家端只读，版本由管理员统一发布。</div><section className="metric-grid"><MetricCard icon={ShieldCheck} label="生效规则包" value={String(rows.filter(row => row.status === 'active').length)} detail="跨平台可追溯" tone="green"/><MetricCard icon={Boxes} label="已覆盖品类" value={String(categories.length)} detail={categorySource} tone="blue"/><MetricCard icon={AlertCircle} label="属性模板字段" value={String(attributeTemplateCount)} detail="来自当前类目目录" tone="amber"/><MetricCard icon={CheckCircle2} label="字段映射" value={mappingStatus} detail="不伪造校验比例" tone="violet"/></section><section className="library-toolbar"><div className="library-tabs" role="tablist" aria-label="规则与品类库"><button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')} role="tab" aria-selected={tab === 'rules'}><ShieldCheck size={15}/>规则库 <span>{rows.length}</span></button><button className={tab === 'categories' ? 'active' : ''} onClick={() => setTab('categories')} role="tab" aria-selected={tab === 'categories'}><Boxes size={15}/>品类库 <span>{categories.length}</span></button></div><label className="library-platform-filter"><span>规则平台</span><select value={platform} onChange={event => setPlatform(event.target.value as PlatformId | 'all')}><option value="all">全部平台</option>{(Object.entries(platformNames) as Array<[PlatformId, string]>).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label className="library-search"><Search size={15}/><span className="sr-only">搜索规则或品类</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={tab === 'rules' ? '搜索规则名称、平台或版本' : '搜索品类、类目编码或属性'} /></label></section>{tab === 'rules' ? <section className="panel rules-list"><div className="panel-heading"><div><span className="section-kicker">ACTIVE RULE PACKS</span><h3>生效规则包</h3></div><StatusChip tone="green">{filteredRules.length} 个结果</StatusChip></div>{filteredRules.map(row => <div className="rule-row" key={row.id}><div className="rule-symbol"><ShieldCheck size={17}/></div><div><b>{row.name}</b><span>{row.version} · 修订 {row.revision ?? 1}</span></div><StatusChip tone="neutral">{row.scope}</StatusChip><span>{row.status === 'active' ? '生效中' : row.status}</span><span className="rule-audit-meta">{row.source?.reference ?? '演示数据'} · {row.source?.checkedAt ?? row.updatedAt}</span></div>)}{!filteredRules.length && <div className="empty-state"><Search size={20}/><b>没有匹配规则</b><span>请调整关键词。</span></div>}</section> : <><div className="info-notice" role="status"><Boxes size={16}/>{categorySource}。类目状态仅代表本地目录状态，提交平台前仍需做字段校验。</div><section className="category-grid">{filteredCategories.map(category => <article className="category-card" key={category.code}><div className="category-card-head"><div className="category-icon"><Boxes size={18}/></div><div><span className="section-kicker">CATALOG {category.code}</span><h3>{category.name}</h3></div><StatusChip tone="green">{category.status === 'active' ? '已生效' : category.status}</StatusChip></div><div className="category-meta"><span><b>平台范围</b>{category.platforms.map(platform => platformNames[platform] ?? platform).join(' · ')}</span><span><b>属性模板</b>{category.fields.join('、')}</span></div><div className="category-card-foot"><span>最近更新：{category.updatedAt}</span><button className="text-button" onClick={() => setSelectedCategory(category)}>查看字段映射 <ArrowRight size={14}/></button></div></article>)}{!filteredCategories.length && <div className="empty-state"><Search size={20}/><b>没有匹配品类</b><span>请调整关键词。</span></div>}</section></>}{selectedCategory && <section className="panel category-mapping-detail" data-testid="category-mapping-detail" aria-label="字段映射详情"><div className="panel-heading"><div><span className="section-kicker">FIELD MAPPING</span><h3>{selectedCategory.name} · 字段映射</h3><p className="panel-subtitle">当前展示平台类目模板字段；提交前仍需以目标平台实时校验为准。</p></div><button className="text-button" onClick={() => setSelectedCategory(null)}>关闭</button></div><div className="category-meta"><span><b>类目编码</b>{selectedCategory.code}</span><span><b>平台范围</b>{selectedCategory.platforms.map(platform => platformNames[platform] ?? platform).join(" · ")}</span></div><div className="mapping-field-list">{selectedCategory.fields.map(field => <span key={field}><CheckCircle2 size={14}/>{field}</span>)}</div></section>}</div>
}

function PublishModal({ close, onComplete, onSubmit, returnFocus, target, preview }: { close: () => void; onComplete: (jobId?: string) => void; onSubmit?: () => Promise<string>; returnFocus: HTMLElement | null; target?: Target; preview?: PublishPreview | null }) {
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  useEffect(() => { loadingRef.current = loading }, [loading])
  useEffect(() => {
    cancelRef.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loadingRef.current) close()
      if (event.key === 'Tab') {
        const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', handler)
    return () => { window.removeEventListener('keydown', handler); returnFocus?.focus() }
  }, [close, returnFocus])
  const submit = () => {
    setLoading(true)
    const operation = onSubmit ? onSubmit() : new Promise<string>(resolve => window.setTimeout(() => resolve('REQ-88214'), 1100))
    operation.then(jobId => onComplete(jobId)).catch((cause: Error) => { setLoading(false); window.alert(`发布未受理：${cause.message}`) })
  }
  const platform = target ? platformNames[target.platform] : preview ? platformNames[preview.task.platform] : '目标平台'
  const tone = target ? platformTone[target.platform] : preview ? platformTone[preview.task.platform] : 'orange'
  const title = preview?.version.body.title ?? target?.title ?? '目标商品'
  const changes = preview?.changes ?? []
  const actionLabel = preview?.operation === 'create' ? '创建' : '更新'
  const identityError = !target ? '发布目标缺少店铺身份，已阻止发布。' : validateTargetStoreIdentity(target) ?? (preview ? validateTaskStoreIdentity(target, preview.task) : null)
  return <div className="modal-layer" role="presentation"><div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="publish-title"><div className="modal-head"><div className="modal-icon"><Rocket size={21}/></div><div><span className="section-kicker">SECOND CONFIRMATION</span><h2 id="publish-title">确认{actionLabel}{platform}商品</h2></div><button className="icon-button" onClick={close} disabled={loading} aria-label="关闭发布确认"><X size={19}/></button></div><div className="modal-body"><div className="publish-target"><div className={`platform-logo ${tone}`}>{platform.slice(0, 1)}</div><div><b>{title}</b><span>{target?.storeName && target.accountId ? storeIdentityLabel(target) : '店铺身份缺失'}</span><span>{preview ? `服务端快照 ${preview.remoteSnapshotHash.slice(0, 12)}…` : '正在等待服务端发布预览'}</span></div><StatusChip tone={preview && !identityError ? 'green' : 'amber'}>{preview && !identityError ? <><Check size={12}/>快照最新</> : '不可确认'}</StatusChip></div>{identityError && <ErrorNotice message={identityError} compact />}<div className="change-summary"><h3>本次将{actionLabel}并写入 {changes.length || 0} 个字段</h3>{changes.length ? changes.map(change => <div key={change}><span>{change}</span><b>{actionLabel}</b></div>) : <div><span>等待服务端 diff</span><b>不可确认</b></div>}<div className="unchanged"><span>价格、库存、SKU、上下架状态</span><b>不会修改</b></div></div><div className="safety-note"><ShieldCheck size={18}/><div><b>发布保护已开启</b><span>请求使用一次性确认令牌和幂等键。若平台超时，系统将先查询状态再决定是否重试。</span></div></div><label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={loading || !preview || Boolean(identityError)}/><span>我确认将审核后的内容写入{target?.storeName ?? '目标店铺'}（账号 {target?.accountId ?? '缺失'}）的上述{platform}商品，并理解平台可能进入审核。</span></label></div><div className="modal-actions"><button className="secondary" onClick={close} ref={cancelRef} disabled={loading}>返回检查</button><button className="danger-action" disabled={!confirmed || loading || !preview || Boolean(identityError)} onClick={submit}>{loading ? <><RefreshCw className="spin" size={16}/>正在安全提交…</> : <><Rocket size={16}/>确认{actionLabel}{platform}商品</>}</button></div></div></div>
}

export default function App() {
  const [page, setPage] = useState<Page>('overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [publishModal, setPublishModal] = useState(false)
  const [toast, setToast] = useState('')
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const [target, setTarget] = useState<Target | undefined>()
  const [taskContext, setTaskContext] = useState<TaskContext | null>(null)
  const [publishPreview, setPublishPreview] = useState<PublishPreview | null>(null)
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanel | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')
  const publishTrigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const closeNav = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileNav(false); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector<HTMLInputElement>('.search-box input')?.focus() } }
    window.addEventListener('keydown', closeNav)
    return () => window.removeEventListener('keydown', closeNav)
  }, [])
  useEffect(() => {
    const baseUrl = import.meta.env.VITE_API_BASE_URL
    if (!baseUrl) return
    fetchApiHealth(baseUrl).then(() => setApiOnline(true)).catch(() => setApiOnline(false))
  }, [])
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
  const openPublish = async () => {
    if (!taskContext?.task || !taskContext.version) { setToast('请先选择商品并完成内容审核'); return }
    if (!target) { setToast('发布目标缺少店铺身份，已阻止发布。请返回商品列表重新选择。'); return }
    const currentIdentityError = validateTargetStoreIdentity(target) ?? validateTaskStoreIdentity(target, taskContext.task)
    if (currentIdentityError) { setToast(currentIdentityError); return }
    publishTrigger.current = document.activeElement as HTMLElement | null
    try {
      const preview = apiBaseUrl ? await preparePublish(apiBaseUrl, taskContext.task.id) : null
      const previewIdentityError = preview ? validateTaskStoreIdentity(target, preview.task) : null
      if (previewIdentityError) { setToast(previewIdentityError); return }
      setPublishPreview(preview); setPublishModal(true)
    }
    catch (cause) { setToast(`发布预览失败：${describeApiError(cause)}`); window.setTimeout(() => setToast(''), 5000) }
  }
  const submitPublish = async () => {
    if (!apiBaseUrl) return 'REQ-88214'
    if (!taskContext?.task || !taskContext.version || !target) throw new Error('请先完成目标商品的内容审核，并确认完整店铺身份后再进入发布。')
    const task = taskContext.task
    const draft = taskContext.version
    const preview = publishPreview ?? await preparePublish(apiBaseUrl, task.id)
    const identityError = validateTargetStoreIdentity(target) ?? validateTaskStoreIdentity(target, task) ?? validateTaskStoreIdentity(target, preview.task)
    if (identityError) throw new Error(identityError)
    const job = await confirmPublish(apiBaseUrl, { task_id: task.id, content_version_id: draft.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, account_id: target.accountId }, `ui-${task.id}-${draft.id}`)
    return job.id
  }
  const completePublish = (jobId = 'REQ-88214') => { setPublishModal(false); setPage('publish'); setToast(`发布请求已受理：${jobId}。平台生效前会持续显示为“审核中”。`); window.setTimeout(() => setToast(''), 5000) }
  const openCorrection = async (job: PublishJob) => {
    if (!apiBaseUrl) return
    try {
      const [rejectedTask, currentProducts] = await Promise.all([fetchTask(apiBaseUrl, job.taskId), fetchProducts(apiBaseUrl)])
      const rejectedProduct = currentProducts.find(item => item.id === rejectedTask.productId)
      if (!rejectedProduct) throw new Error('被驳回任务的商品已不在当前工作区，已阻止修正。')
      const correctionTarget = { productId: rejectedTask.productId, platform: rejectedTask.platform, title: rejectedProduct.title, remoteId: rejectedProduct.remoteId, accountId: rejectedTask.accountId, storeName: rejectedProduct.storeName, taskId: rejectedTask.id }
      const identityError = validateProductStoreIdentity(correctionTarget, rejectedProduct) ?? validateTaskStoreIdentity(correctionTarget, rejectedTask) ?? (job.accountId && job.accountId !== rejectedTask.accountId ? '发布回执店铺账号与任务不一致，已阻止修正。' : null)
      if (identityError) throw new Error(identityError)
      setTarget(correctionTarget)
      setTaskContext(null)
      setPage('task')
      setToast('已定位到被驳回的内容。请按平台原因修改；保存后会生成待审核的新版本。')
      window.setTimeout(() => setToast(''), 6000)
    } catch (cause) { setToast(`无法打开修正任务：${describeApiError(cause)}`) }
  }
  const searchProducts = () => {
    const query = globalSearch.trim()
    if (!query) return
    setTarget(undefined)
    setTaskContext(null)
    setPage('products')
  }
  return <div className="app-shell">
    <div className="app-content" inert={publishModal}>
      <Sidebar page={page} setPage={setPage} open={mobileNav} close={() => setMobileNav(false)} onOpenUtility={setUtilityPanel} />
      <div className="main-shell"><Topbar page={page} openMenu={() => setMobileNav(true)} apiOnline={apiOnline} onOpenUtility={setUtilityPanel} searchQuery={globalSearch} onSearchQuery={setGlobalSearch} onSearch={searchProducts} /><div className={`page ${page === 'task' ? 'task-page' : ''}`}>{page === 'overview' && <Overview goTask={() => { setTarget(undefined); setTaskContext(null); setPage('products') }} goProducts={() => setPage('products')} goTasks={() => setPage('task')} baseUrl={apiBaseUrl} onOpenUtility={setUtilityPanel} />}{page === 'products' && <Products baseUrl={apiBaseUrl} initialQuery={globalSearch} onSelectTarget={next => { setTarget(next); setTaskContext(null); setPage('task') }} />}{page === 'task' && <TaskWorkspace openPublish={openPublish} baseUrl={apiBaseUrl} target={target} onContext={setTaskContext} onSelectTarget={next => { setTarget(next); setTaskContext(null) }} onBack={() => { setTarget(undefined); setTaskContext(null) }} />}{page === 'publish' && <PublishCenter openPublish={openPublish} openCorrection={openCorrection} baseUrl={apiBaseUrl} canOpenPublish={Boolean(taskContext?.task && taskContext.version)} />}{page === 'rules' && <Rules baseUrl={apiBaseUrl} />}</div></div>
    </div>
    {publishModal && target && <PublishModal close={() => setPublishModal(false)} preview={publishPreview} target={target} onSubmit={submitPublish} onComplete={completePublish} returnFocus={publishTrigger.current} />}
    {utilityPanel && <UtilityPanel panel={utilityPanel} apiOnline={apiOnline} apiBaseUrl={apiBaseUrl} onClose={() => setUtilityPanel(null)} />}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite"><CheckCircle2 size={18}/>{toast}</div>
  </div>
}
