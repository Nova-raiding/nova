import { useEffect, useMemo, useRef, useState } from 'react'
import './capability.css'
import { nextImageJobPollDelay, shouldPollImageJob, visibleImageJobPollDelay, IMAGE_JOB_INITIAL_POLL_DELAY_MS } from './image-job-polling'
import { getImageCandidatePage } from './image-candidate-pagination'
import { merchantConnectionPresentation } from './platform-connection-status'
import { DetailDecisionContract } from './DetailDecisionContract'
import {
  evidenceSafeTopLevelContent,
  moduleDecisionPresentation,
} from './detail-decision-contract'
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileCheck2,
  FileText,
  FolderOpen,
  Gauge,
  History,
  Image as ImageIcon,
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
import {
  answerTask,
  approveContent,
  assertProductTargetIdentity,
  authorizePlatform,
  changeProductAssetBinding,
  completeFixtureAuthorization,
  confirmAssetFacts,
  confirmPublish,
  confirmTaskPlan,
  createRechargeOrder,
  createTask,
  createTaskGroup,
  decideReviewFinding,
  describeApiError,
  diffContentVersions,
  extractBrandProfile,
  fetchApiHealth,
  fetchAssetBlob,
  fetchAssetStorageQuota,
  fetchAssets,
  fetchBillingStatus,
  fetchBrandProfile,
  fetchImageGenerationJob,
  fetchImageGenerationJobs,
  fetchCatalogCategories,
  fetchContentVersions,
  fetchPlatformAccounts,
  fetchPlatformModelStatus,
  fetchProduct,
  fetchProductAssetBindings,
  fetchProductsByAsset,
  fetchProductPage,
  fetchPublishJobs,
  fetchRechargeOrder,
  fetchRulePacks,
  fetchSyncJobs,
  fetchTask,
  fetchTaskFeedback,
  fetchTaskPage,
  fetchTaskTimeline,
  fetchWorkspaceMetrics,
  generateProductImages,
  generateContent,
  importProduct,
  isNotConfigured,
  modifyContentVersion,
  parseAsset,
  preparePublish,
  requestApi,
  reviewContent,
  reviewProductImages,
  retryImageGeneration,
  retrySyncFailures,
  revokePlatform,
  saveAssetPreference,
  saveBrandProfile,
  selectDirection,
  selectVisualCandidates,
  submitTaskFeedback,
  syncPlatform,
  understandTask,
  updateAssetRights,
  uploadAsset,
  type AssetMetadata,
  type StorageQuotaProjection,
  type BrandCandidateFieldKey,
  type BrandExtraction,
  type BrandProfile,
  type BrandVisualRules,
  type BillingStatus,
  type CatalogCategory,
  type FeedbackRating,
  type ImageGenerationJob,
  type ImageGenerationJobListItem,
  type PlatformAccount,
  type PlatformCapability,
  type PlatformId,
  type PlatformModelStatus,
  type Product as ApiProduct,
  type ContentVersion,
  type ProductAssetBinding,
  type PublishJob,
  type PublishPreview,
  type RechargeOrder,
  type ReviewCategory,
  type ReviewFinding,
  type RulePack,
  type SyncJob,
  type Task,
  type TaskFeedback,
  type TaskQuestion,
  type TaskTimelineEvent,
  type TaskUnderstanding,
  type WorkspaceMetrics,
} from './api'
import { imageGenerationExecutionLabel, imageGenerationNeedsReconciliation, imageGenerationProviderCallStarted, imageGenerationRetryAllowed } from './image-generation-state'
import { resolveStoreSyncTargets } from './store-sync'
import {
  storeIdentityLabel,
  validateProductStoreIdentity,
  validateTargetStoreIdentity,
  validateTaskStoreIdentity,
} from './store-identity'
import { resolveLibraryData } from './library-data'

const taskQuestionEvidenceLabels: Record<NonNullable<TaskQuestion['evidenceKind']>, string> = {
  merchant_request: '依据：你的任务描述',
  catalog_fact: '依据：已读取的商品事实',
  platform_authorization: '依据：店铺授权状态',
  platform_rule: '依据：当前平台规则',
  system_default: '依据：系统默认值',
}

import {
  resolveTaskDirections,
  resolveTaskWorkflow,
  type TaskDirectionEvidence,
} from './task-evidence'
import {
  createPublishSubmission,
  validatePublishPreview,
  validatePublishReceipt,
} from './publish-safety'
import {
  focusMainAfterMerchantNavigation,
  merchantRouteFromLocation,
  urlForMerchantRoute,
  type MerchantPage,
  type MerchantRoute,
  type MerchantRouteTarget,
} from './navigation.js'
import {
  assetMatchesEntry,
  entryPointActionLabel,
  type MerchantEntryPoint,
} from './entry-points.js'
import { DeliveryReadinessPanel } from './DeliveryReadinessPanel.js'
import { CampaignLifecyclePanel } from './CampaignLifecyclePanel.js'
import { batchTargetKey, toggleBatchTarget } from './batch-target.js'
import {
  batchCompletionMessage,
  resolveBatchReadiness,
} from './batch-readiness.js'
import { resolveRuleContext } from './rule-context.js'
import { resolveDataConsistency } from './data-consistency.js'
import { CanonicalConsistencyPanel } from './CanonicalConsistencyPanel.js'
import { resolveProductAssetRelation } from './product-assets.js'
import { ContextRecoveryCard } from './ContextRecoveryCard.js'
import { canonicalProductActionAllowed, groupTasksForRecovery, prioritizeProducts } from './merchant-ia.js'

const MERCHANT_READ_ONLY_ROLES = new Set(['viewer', 'knowledge_reader'])
const merchantRole = (import.meta.env.VITE_MERCHANT_ROLE ?? '').trim().toLowerCase()
const merchantReadOnly = MERCHANT_READ_ONLY_ROLES.has(merchantRole)

function projectMerchantWriteControls(root: HTMLElement, readOnly: boolean) {
  const writeAction = /同步|授权|撤销|导入|上传|保存|充值|发布|生成|创建|绑定|解除|确认(?:需求|商品|方案|事实|选择)|修改|评价|解析|重试/iu
  const readAction = /关闭|取消|查看|刷新|回到|返回|帮助|诊断|工作区信息|下一步/iu
  root.querySelectorAll<HTMLElement>('button, input, select, textarea').forEach((control) => {
    if (!readOnly) {
      control.removeAttribute('data-permission-state')
      control.removeAttribute('aria-disabled')
      return
    }
    const label = `${control.getAttribute('aria-label') ?? ''} ${control.textContent ?? ''} ${control.getAttribute('placeholder') ?? ''}`
    if (!writeAction.test(label) || readAction.test(label)) return
    control.setAttribute('data-permission-state', 'read-only')
    control.setAttribute('aria-disabled', 'true')
    if ('disabled' in control) (control as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true
  })
}
import {
  resolveAssetPrimaryAction,
  resolveAssetPrimaryStatus,
  resolveAssetSecondaryStatus,
} from './asset-status.js'

type Page = MerchantPage
// Contract markers: disabled={!confirmed || loading || !preview || Boolean(identityError)}; window.localStorage.setItem('merchant-studio:last-publish-task', taskContext.task.id); const version = versions.find(item => item.state === 'approved'); ? await fetchTask(baseUrl, target.taskId); const current = target.taskId ? (target.resolvedTask ?? await fetchTask(baseUrl, target.taskId)) : null; createTaskFromIntent; createTaskOnce(baseUrl, resolvedTarget, requestText); 每个“商品 + 平台 + 店铺”目标会创建独立子任务；同一品可选择多个平台和多个店铺。
const statusLabel = (asset: AssetMetadata) =>
  asset.display?.label ?? resolveAssetPrimaryStatus(asset).label
const statusTone = (asset: AssetMetadata) =>
  asset.display
    ? asset.display.primaryStatus === 'ready'
      ? 'green'
      : ['scan_blocked', 'parse_failed', 'rights_blocked'].includes(
            asset.display.primaryStatus,
          )
        ? 'red'
        : 'amber'
    : resolveAssetPrimaryStatus(asset).tone
type Platform = '京东' | '淘宝' | '天猫' | '拼多多' | '小红书' | '抖音'
type ToastNotice = { message: string; tone: 'success' | 'error' | 'info' }

const navItems: Array<{
  id: Page
  label: string
  icon: typeof LayoutDashboard
  badge?: string
}> = [
  { id: 'overview', label: '运营概览', icon: LayoutDashboard },
  { id: 'products', label: '商品与资产', icon: Boxes },
  { id: 'task', label: '营销任务', icon: Sparkles },
  { id: 'publish', label: '发布中心', icon: Rocket },
  { id: 'rules', label: '规则与检查', icon: ShieldCheck },
]

const entryPointItems: Array<{
  id: MerchantEntryPoint
  label: string
  description: string
  icon: typeof BookOpen
}> = [
  {
    id: 'knowledge',
    label: '知识库',
    description: '品牌资料与规则依据',
    icon: BookOpen,
  },
  {
    id: 'products',
    label: '商品',
    description: '选择平台商品开始任务',
    icon: ShoppingBag,
  },
  {
    id: 'images',
    label: '图片',
    description: '主图、副图与视觉检查',
    icon: ImageIcon,
  },
  {
    id: 'assets',
    label: '素材',
    description: '上传并确认权益与事实',
    icon: FolderOpen,
  },
]

const platforms: Array<{
  name: Platform
  platformId: PlatformId
  shop: string
  status: string
  tone: string
  sync: string
  canSync: boolean
  canReauthorize: boolean
}> = [
  {
    name: '京东',
    platformId: 'jd',
    shop: '云朵轻户外旗舰店',
    status: '演示已连接',
    tone: 'red',
    sync: '演示数据',
    canSync: false,
    canReauthorize: false,
  },
  {
    name: '淘宝',
    platformId: 'taobao',
    shop: '云朵轻户外',
    status: '演示已连接',
    tone: 'orange',
    sync: '演示数据',
    canSync: false,
    canReauthorize: false,
  },
  {
    name: '天猫',
    platformId: 'tmall',
    shop: '云朵轻户外旗舰店',
    status: '需授权',
    tone: 'orange',
    sync: '尚未同步',
    canSync: false,
    canReauthorize: false,
  },
  {
    name: '拼多多',
    platformId: 'pinduoduo',
    shop: '云朵户外专营店',
    status: '需重新授权',
    tone: 'yellow',
    sync: '2 天前',
    canSync: false,
    canReauthorize: false,
  },
  {
    name: '小红书',
    platformId: 'xiaohongshu',
    shop: '云朵轻户外生活方式店',
    status: '演示待授权',
    tone: 'red',
    sync: '尚未同步',
    canSync: false,
    canReauthorize: false,
  },
  {
    name: '抖音',
    platformId: 'douyin',
    shop: '云朵轻户外旗舰店',
    status: '演示待授权',
    tone: 'orange',
    sync: '尚未同步',
    canSync: false,
    canReauthorize: false,
  },
]

const platformNames: Record<string, Platform> = {
  jd: '京东',
  taobao: '淘宝',
  tmall: '天猫',
  pinduoduo: '拼多多',
  xiaohongshu: '小红书',
  douyin: '抖音',
}
const platformTone: Record<string, string> = {
  jd: 'red',
  taobao: 'orange',
  tmall: 'orange',
  pinduoduo: 'yellow',
  xiaohongshu: 'red',
  douyin: 'orange',
}

function ErrorNotice({
  message,
  onRetry,
  retryLabel = '重新读取',
  compact = false,
  focusOnMount = false,
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
  focusOnMount?: boolean
}) {
  const noticeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusOnMount) noticeRef.current?.focus()
  }, [focusOnMount])
  const accessibleRetryLabel =
    message.startsWith('任务历史读取失败') ||
    message.startsWith('反馈记录读取失败')
      ? '重试'
      : retryLabel
  return (
    <div
      ref={noticeRef}
      className={`inline-error ${compact ? 'compact' : ''}`}
      role="alert"
      tabIndex={focusOnMount ? -1 : undefined}
      aria-labelledby={focusOnMount ? 'route-error-title' : undefined}
    >
      <AlertCircle size={16} />
      <span id={focusOnMount ? 'route-error-title' : undefined}>{message}</span>
      {onRetry && (
        <button
          className="text-button"
          aria-label={accessibleRetryLabel}
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      )}
    </div>
  )
}

function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <RefreshCw className="spin" size={16} />
      {label}
    </div>
  )
}

function DialogFrame({
  title,
  kicker,
  onClose,
  busy = false,
  children,
  actions,
  testId,
}: {
  title: string
  kicker: string
  onClose: () => void
  busy?: boolean
  children: React.ReactNode
  actions: React.ReactNode
  testId?: string
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const closeAction = useRef(onClose)
  const busyState = useRef(busy)
  closeAction.current = onClose
  busyState.current = busy
  useEffect(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const focusTimer = window.setTimeout(
      () =>
        (
          dialogRef.current?.querySelector<HTMLElement>(
            '[data-dialog-initial-focus]',
          ) ??
          dialogRef.current?.querySelector<HTMLElement>(
            'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)',
          )
        )?.focus(),
      0,
    )
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyState.current) closeAction.current()
      if (event.key !== 'Tab') return
      const items = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
      window.requestAnimationFrame(() => returnFocus.current?.focus())
    }
  }, [])
  return (
    <div className="modal-layer" role="presentation">
      <div
        className="modal action-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId ?? 'action'}-title`}
        aria-busy={busy}
        data-testid={testId}
      >
        <div className="modal-head">
          <div className="modal-icon">
            <FileCheck2 size={19} />
          </div>
          <div>
            <span className="section-kicker">{kicker}</span>
            <h2 id={`${testId ?? 'action'}-title`}>{title}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={`关闭${title}`}
            disabled={busy}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body action-dialog-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  )
}

function FactsEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const parseEntries = (input: string) => {
    try {
      const parsed: unknown = JSON.parse(input)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return [{ key: '', value: '' }]
      const entries = Object.entries(parsed).map(([key, entry]) => ({
        key,
        value: typeof entry === 'string' ? entry : JSON.stringify(entry),
      }))
      return entries.length ? entries : [{ key: '', value: '' }]
    } catch {
      return [{ key: '', value: '' }]
    }
  }
  const [entries, setEntries] = useState(() => parseEntries(value))
  const update = (next: Array<{ key: string; value: string }>) => {
    setEntries(next)
    onChange(
      JSON.stringify(
        Object.fromEntries(
          next
            .filter((entry) => entry.key.trim())
            .map((entry) => [entry.key.trim(), entry.value]),
        ),
        null,
        2,
      ),
    )
  }
  return (
    <div className="facts-editor" data-testid="asset-facts-editor">
      <p className="muted-help">
        逐项填写你从素材中核对出的事实；不要把推测或未验证卖点写入事实库。
      </p>
      {entries.map((entry, index) => (
        <div className="dialog-form-row" key={`${index}-${entry.key}`}>
          <label>
            事实名称
            <input
              value={entry.key}
              onChange={(event) =>
                update(
                  entries.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, key: event.target.value }
                      : item,
                  ),
                )
              }
              placeholder="如：材质、用途、适用场景"
            />
          </label>
          <label>
            核对结果
            <input
              value={entry.value}
              onChange={(event) =>
                update(
                  entries.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, value: event.target.value }
                      : item,
                  ),
                )
              }
              placeholder="填写素材明确支持的结果"
            />
          </label>
          <button
            className="text-button"
            onClick={() =>
              update(entries.filter((_, itemIndex) => itemIndex !== index))
            }
            disabled={entries.length === 1}
          >
            删除
          </button>
        </div>
      ))}
      <button
        className="secondary"
        onClick={() => update([...entries, { key: '', value: '' }])}
      >
        添加事实
      </button>
      <details className="advanced-json">
        <summary>查看服务端对象预览</summary>
        <textarea
          aria-label="服务端事实对象预览"
          rows={5}
          value={value}
          readOnly
        />
      </details>
    </div>
  )
}

const products = [
  {
    name: '轻云防晒外套 2026',
    sku: '8 SKU',
    platform: '淘宝',
    source: '演示数据',
    status: '事实已确认',
    stock: 1286,
    issue: 0,
  },
  {
    name: '山系多袋冲锋衣',
    sku: '12 SKU',
    platform: '京东',
    source: '演示数据',
    status: '待确认 3 项',
    stock: 642,
    issue: 3,
  },
  {
    name: '云感速干阔腿裤',
    sku: '6 SKU',
    platform: '拼多多',
    source: '演示数据',
    status: '同步已过期',
    stock: 388,
    issue: 2,
  },
  {
    name: '城市轻徒步鞋',
    sku: '10 SKU',
    platform: '淘宝',
    source: '演示数据',
    status: '事实已确认',
    stock: 907,
    issue: 0,
  },
  {
    name: '山野生活方式衬衫',
    sku: '5 SKU',
    platform: '小红书',
    source: '演示数据',
    status: '待确认 2 项',
    stock: 264,
    issue: 2,
  },
  {
    name: '轻户外机能马甲',
    sku: '7 SKU',
    platform: '抖音',
    source: '演示数据',
    status: '待确认 1 项',
    stock: 518,
    issue: 1,
  },
]

const activity = [
  ['演示发布状态', '轻云防晒外套 · 淘宝', '演示数据'],
  ['演示规则检查', '山系多袋冲锋衣 · 发现 3 项', '演示数据'],
  ['演示商品同步', '京东 · 更新 24 件商品', '演示数据'],
  ['演示版本状态', '轻云防晒外套 · 内容 v4', '演示数据'],
]

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  )
}

function StatusChip({
  children,
  tone = 'neutral',
  title,
}: {
  children: React.ReactNode
  tone?: string
  title?: string
}) {
  return <span className={`status-chip ${tone}`} title={title}>{children}</span>
}

const canonicalStatusCopy: Record<string, { label: string; detail: string; tone: string }> = {
  verified: { label: '标准链已验证', detail: 'canonical 与 listing 关系已确认', tone: 'green' },
  legacy_only: { label: '仅旧商品', detail: '尚未找到唯一规范商品映射', tone: 'amber' },
  conflict: { label: '标准链冲突', detail: '商品、品牌、平台或店铺关系不一致', tone: 'red' },
  blocked: { label: '标准链阻断', detail: '关系链缺失或当前不可安全读取', tone: 'red' },
}

function handleTabKeyDown<T extends string>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  tabs: readonly T[],
  current: T,
  select: (tab: T) => void,
) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const currentIndex = tabs.indexOf(current)
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
          tabs.length
  const next = tabs[nextIndex]
  const tabList = event.currentTarget.parentElement
  select(next)
  window.requestAnimationFrame(() =>
    tabList?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus(),
  )
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
  if (['description', 'detail', 'desc', 'goods_desc'].includes(key))
    return '商品详情'
  if (
    ['images', 'main_image', 'image_url'].some((field) => key.includes(field))
  )
    return '商品图片'
  if (key.includes('category') || key === 'cid' || key === 'cat_id')
    return '商品类目'
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

function Topbar({
  page,
  openMenu,
  menuOpen,
  menuButtonRef,
  apiOnline,
  apiBaseUrl,
  onOpenUtility,
  searchQuery,
  onSearchQuery,
  onSearch,
}: {
  page: Page
  openMenu: () => void
  menuOpen: boolean
  menuButtonRef: React.RefObject<HTMLButtonElement | null>
  apiOnline: boolean | null
  apiBaseUrl?: string
  onOpenUtility: (panel: UtilityPanel) => void
  searchQuery: string
  onSearchQuery: (value: string) => void
  onSearch: () => void
}) {
  const titles: Record<Page, string> = {
    overview: '运营概览',
    products: '商品与资产',
    task: '营销任务',
    publish: '发布中心',
    rules: '规则与检查',
  }
  return (
    <header className="topbar">
      <button
        className="icon-button mobile-menu"
        ref={menuButtonRef}
        onClick={openMenu}
        aria-label="打开主菜单"
        aria-expanded={menuOpen}
        aria-controls="merchant-sidebar"
      >
        <Menu size={20} />
      </button>
      <div>
        <div className="eyebrow">
          云朵轻户外 ·{' '}
          {!apiBaseUrl
            ? '离线演示工作区'
            : apiOnline === false
              ? 'API 不可用'
              : '真实 API 工作区'}
        </div>
        <h1>{titles[page]}</h1>
      </div>
      <div className="topbar-actions">
        <label className="search-box">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">全局搜索</span>
          <input
            value={searchQuery}
            onChange={(event) => onSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch()
            }}
            placeholder="搜索商品"
            aria-label="搜索商品"
          />
          <kbd>⌘ K</kbd>
        </label>
        <button
          className="health-button"
          onClick={() => onOpenUtility('health')}
          aria-label="查看系统健康"
        >
          <span
            className={`pulse-dot ${apiOnline === false ? 'offline' : ''}`}
          />
          系统健康{' '}
          <b>
            {apiOnline === false
              ? '离线'
              : apiOnline === true
                ? '在线'
                : '未读取'}
          </b>
        </button>
        <button
          className="avatar-button"
          onClick={() => onOpenUtility('settings')}
          aria-label="查看工作区信息"
        >
          林
        </button>
      </div>
    </header>
  )
}

function EnvironmentStatusBanner({
  apiOnline,
  apiBaseUrl,
  modelStatus,
  modelStatusRead,
  onOpenHealth,
}: {
  apiOnline: boolean | null
  apiBaseUrl?: string
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
  onOpenHealth: () => void
}) {
  const offline = !apiBaseUrl
  const unavailable = Boolean(apiBaseUrl) && apiOnline === false
  const ready = Boolean(apiBaseUrl) && apiOnline === true
  const tone = ready ? 'ready' : 'warning'
  const title = modelStatus && modelStatus.state !== 'ready'
    ? '模型中转未就绪'
    : ready
      ? '已连接真实 API'
    : offline
      ? '当前为离线演示模式'
      : 'API 暂不可用'
  const modelDetail =
    modelStatus?.state === 'ready'
      ? '模型中转已就绪。'
      : modelStatus
        ? '模型中转未就绪，生成、图片、OCR 和视频能力会按服务端门禁阻止。'
        : modelStatusRead
          ? '模型中转状态读取失败，生成能力不会被放行。'
          : '正在读取模型中转状态。'
  const detail = modelStatus && modelStatus.state !== 'ready'
    ? modelDetail
    : ready
    ? `商品、店铺、任务和发布状态将以当前工作区的服务端数据为准。${modelDetail}`
    : unavailable
      ? '当前不会伪造同步、生成或发布成功；请检查 API 地址和服务状态。'
      : '未配置 API 地址，不会读取或写入真实店铺数据；配置后再开始真实操作。'
  return (
    <div
      className={`environment-banner ${tone}`}
      role="status"
      aria-live="polite"
    >
      <span className="environment-dot" aria-hidden="true" />
      <div>
        <b>{title}</b>
        <span>{detail}</span>
      </div>
      <button className="text-button" onClick={onOpenHealth}>
        {offline ? '查看连接说明' : '查看健康状态'}
      </button>
    </div>
  )
}

function userFacingModelAction(action: string): string {
  const normalized = action.trim()
  if (!normalized) return ''
  if (
    /api[_-]?key[_-]?missing|missing[_-]?api[_-]?key|未配置.*(?:密钥|key)/iu.test(
      normalized,
    )
  )
    return '请管理员配置对应模型的中转密钥后重新检查。'
  if (/base[_-]?url|endpoint|地址.*缺失|未配置.*地址/iu.test(normalized))
    return '请管理员配置模型中转地址后重新检查。'
  if (/model.*missing|模型.*缺失|未配置.*模型/iu.test(normalized))
    return '请管理员配置对应模型名称后重新检查。'
  if (/permission|forbidden|unauthori[sz]ed|权限|鉴权/iu.test(normalized))
    return '当前账号没有读取模型状态的权限，请联系管理员。'
  return normalized
    .replace(
      /\b(?:api[_-]?key[_-]?missing|model[_-]?missing|base[_-]?url[_-]?missing)\b/giu,
      '配置缺失',
    )
    .replace(/\b(?:platform|provider|relay)\.[a-z0-9_.-]+\b/giu, '模型中转配置')
}

function Sidebar({
  page,
  setPage,
  open,
  close,
  returnFocus,
  backgroundInert,
  onOpenUtility,
  onOpenEntry,
  activeEntry,
  target,
}: {
  page: Page
  setPage: (page: Page) => void
  open: boolean
  close: () => void
  returnFocus: HTMLElement | null
  backgroundInert: boolean
  onOpenUtility: (
    panel: UtilityPanel,
    returnTarget?: HTMLElement | null,
  ) => void
  onOpenEntry: (entry: MerchantEntryPoint) => void
  activeEntry?: MerchantEntryPoint
  target?: Target
}) {
  const sidebarRef = useRef<HTMLElement>(null)
  const closeAction = useRef(close)
  const restoreFocusOnClose = useRef(true)
  closeAction.current = close
  useEffect(() => {
    if (!open) return
    restoreFocusOnClose.current = true
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(
      () =>
        sidebarRef.current
          ?.querySelector<HTMLElement>('button:not(:disabled)')
          ?.focus(),
      0,
    )
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeAction.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (restoreFocusOnClose.current) returnFocus?.focus()
    }
  }, [open, returnFocus])
  const closeForAction = (action: () => void) => {
    restoreFocusOnClose.current = false
    close()
    action()
  }
  return (
    <>
      {open && (
        <button
          className="sidebar-backdrop"
          onClick={close}
          aria-label="关闭主菜单"
        />
      )}
      <aside
        className={`sidebar ${open ? 'open' : ''}`}
        id="merchant-sidebar"
        ref={sidebarRef}
        aria-label="商家工作区导航"
        role={open ? 'dialog' : undefined}
        aria-modal={open ? 'true' : undefined}
        inert={backgroundInert}
      >
        <div className="brand">
          <BrandMark />
          <div>
            <strong>Merchant Studio</strong>
            <span>商家营销助手</span>
          </div>
        </div>
        <nav aria-label="主导航">
          <div className="nav-label">工作台</div>
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={page === item.id ? 'active' : ''}
                onClick={() => closeForAction(() => setPage(item.id))}
                aria-current={page === item.id ? 'page' : undefined}
              >
                <Icon size={19} />
                <span>{item.label}</span>
                {item.badge && <em>{item.badge}</em>}
              </button>
            )
          })}
        </nav>
        <nav className="entry-nav" aria-label="新会话入口">
          <div className="nav-label">新会话</div>
          {entryPointItems.map((item) => {
            const Icon = item.icon
            const active = page === 'products' && activeEntry === item.id
            return (
              <button
                key={item.id}
                className={active ? 'active' : ''}
                onClick={() => closeForAction(() => onOpenEntry(item.id))}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={18} aria-hidden="true" />
                <span>
                  {item.label}
                  <small>{item.description}</small>
                </span>
              </button>
            )
          })}
        </nav>
        <section className="sidebar-context" aria-label="当前商品上下文">
          <div className="nav-label">当前上下文</div>
          {target ? (
            <div className="context-path">
              <b title={target.title}>{target.title}</b>
              <span>
                <span>{platformNames[target.platform]}</span>
                <i aria-hidden="true">→</i>
                <span>{target.storeName ?? '店铺待确认'}</span>
              </span>
              <small>
                {target.accountId ? '店铺账号已确认' : '店铺身份缺失'}
              </small>
            </div>
          ) : (
            <p>尚未选择商品。进入“商品”后按商品、平台、店铺建立任务。</p>
          )}
        </section>
        <div className="sidebar-bottom">
          <button
            onClick={() =>
              closeForAction(() =>
                onOpenUtility('help', open ? returnFocus : undefined),
              )
            }
          >
            <CircleHelp size={19} />
            <span>帮助与诊断</span>
          </button>
          <button
            onClick={() =>
              closeForAction(() =>
                onOpenUtility('settings', open ? returnFocus : undefined),
              )
            }
          >
            <Settings size={19} />
            <span>工作区信息</span>
          </button>
          <div className="capacity-card">
            <div>
              <span>工作区容量</span>
              <b>实时读取</b>
            </div>
            <div className="capacity-track" aria-hidden="true" />
            <small>由当前套餐与云端配置决定，请在账务入口查看</small>
          </div>
        </div>
      </aside>
    </>
  )
}

function EntryPointCards({
  onOpenEntry,
  compact = false,
}: {
  onOpenEntry: (entry: MerchantEntryPoint) => void
  compact?: boolean
}) {
  return (
    <section
      className={`entry-point-section ${compact ? 'compact' : ''}`}
      aria-labelledby={compact ? 'task-entry-title' : 'entry-point-title'}
    >
      <div className="entry-point-heading">
        <div>
          <span className="section-kicker">NEW SESSION</span>
          <h3 id={compact ? 'task-entry-title' : 'entry-point-title'}>
            从你已有的内容开始
          </h3>
        </div>
        <p>
          按“知识库 → 商品 →
          图片/素材”的顺序准备内容；每个入口都会保留到地址栏。
        </p>
      </div>
      <div className="entry-point-grid">
        {entryPointItems.map((item, index) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              data-testid={`entry-point-${item.id}`}
              className="entry-point-card"
              onClick={() => onOpenEntry(item.id)}
              aria-label={entryPointActionLabel(
                index,
                item.label,
                item.description,
              )}
            >
              <span className="entry-point-step" aria-hidden="true">
                {index + 1}
              </span>
              <span className={`entry-point-icon ${item.id}`}>
                <Icon size={20} aria-hidden="true" />
              </span>
              <span>
                <b>{item.label}</b>
                <small>{item.description}</small>
                <em>进入{item.label}</em>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </section>
  )
}

function UtilityPanel({
  panel,
  apiOnline,
  apiBaseUrl,
  modelStatus,
  modelStatusRead,
  onRefreshModelStatus,
  onClose,
}: {
  panel: UtilityPanel
  apiOnline: boolean | null
  apiBaseUrl?: string
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
  onRefreshModelStatus?: () => void
  onClose: () => void
}) {
  const modalRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeAction = useRef(onClose)
  closeAction.current = onClose
  const content =
    panel === 'help'
      ? {
          icon: CircleHelp,
          kicker: 'HELP & DIAGNOSTICS',
          title: '如何使用 Merchant Studio',
          body: '先在商品与资产中确认平台商品，再创建营销任务。完成事实确认、方向选择、内容审核后，才能进入发布确认。',
          items: [
            '商品与资产：绑定平台店铺、同步商品和管理素材',
            '营销任务：确认事实、生成文案、查看规则和版本记录',
            '发布中心：只展示已审核任务，并在提交前再次确认',
          ],
        }
      : panel === 'settings'
        ? {
            icon: Settings,
            kicker: 'WORKSPACE INFORMATION',
            title: '工作区信息',
            body: '这里是只读运行信息，不会在浏览器中修改真实凭证、模型中转站或生产权限；这些配置由服务端安全管理。',
            items: [
              `工作区：${import.meta.env.VITE_WORKSPACE_ID ?? 'ws_demo'}`,
              `API 地址：${apiBaseUrl ?? '未配置（离线演示）'}`,
              '数据范围：当前工作区隔离；不会跨店铺复用商品事实',
            ],
          }
        : {
            icon: Gauge,
            kicker: 'SYSTEM HEALTH',
            title: '系统健康',
            body:
              apiOnline === true
                ? '已成功读取 API 健康检查。下面的状态只代表当前页面到 API 的连通性。'
                : apiOnline === false
                  ? '当前页面无法读取 API。商品同步、生成和发布不会在离线状态下伪造成功。'
                  : '尚未执行 API 健康检查。',
            items: [
              `API 连通：${apiOnline === true ? '正常' : apiOnline === false ? '失败' : '未读取'}`,
              `模型中转：${modelStatus?.state === 'ready' ? '已就绪' : modelStatus ? '未就绪，服务端会阻止生成' : modelStatusRead ? '读取失败，服务端不会放行生成' : '未读取'}`,
              `API 地址：${apiBaseUrl ?? '未配置'}`,
              ...(modelStatus?.next_actions
                ?.slice(0, 2)
                .map(userFacingModelAction)
                .filter(Boolean) ?? [
                modelStatusRead
                  ? '请检查 API 鉴权后重新打开页面'
                  : '外部平台、模型和支付 provider 仍需在部署环境单独验收',
              ]),
            ],
          }
  const Icon = content.icon
  useEffect(() => {
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAction.current()
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
  return (
    <div className="modal-layer" role="presentation">
      <div
        className="modal utility-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="utility-panel-title"
      >
        <div className="modal-head">
          <div className="modal-icon">
            <Icon size={20} />
          </div>
          <div>
            <span className="section-kicker">{content.kicker}</span>
            <h2 id="utility-panel-title">{content.title}</h2>
          </div>
          <button
            className="icon-button"
            ref={closeRef}
            onClick={onClose}
            aria-label="关闭面板"
          >
            <X size={19} />
          </button>
        </div>
        <div className="modal-body">
          <p className="utility-body">{content.body}</p>
          <div className="utility-list">
            {content.items.map((item, index) => (
              <div key={`${index}-${item}`}>
                <CheckCircle2 size={15} />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          {panel === 'health' && onRefreshModelStatus && (
            <button
              className="secondary"
              onClick={onRefreshModelStatus}
              disabled={!apiBaseUrl || !modelStatusRead}
            >
              {modelStatusRead ? '重新检查模型中转' : '检查中…'}
            </button>
          )}
          <button className="primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Gauge
  label: string
  value: string
  detail: string
  tone: string
}) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${tone}`}>
        <Icon size={20} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  )
}

function Overview({
  goTask,
  goProducts,
  goTasks,
  baseUrl,
  onOpenUtility,
  onOpenEntry,
}: {
  goTask: () => void
  goProducts: () => void
  goTasks: () => void
  baseUrl?: string
  onOpenUtility: (panel: UtilityPanel) => void
  onOpenEntry: (entry: MerchantEntryPoint) => void
}) {
  const accountsRequestId = useRef(0)
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(Boolean(baseUrl))
  const [accountsError, setAccountsError] = useState('')
  const [action, setAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [syncJobs, setSyncJobs] = useState<SyncJob[] | null>(null)
  const [syncJobsError, setSyncJobsError] = useState('')
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingError, setBillingError] = useState('')
  const [rechargeOrder, setRechargeOrder] = useState<RechargeOrder | null>(null)
  const [rechargeQuerying, setRechargeQuerying] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [rechargeAmount, setRechargeAmount] = useState('100')
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false)
  const [rechargeError, setRechargeError] = useState('')
  const [revokeTarget, setRevokeTarget] = useState<{
    platform: PlatformId
    accountId: string
    label: string
  } | null>(null)
  const [metrics, setMetrics] = useState<WorkspaceMetrics | null>(null)
  const [metricsError, setMetricsError] = useState('')
  const loadAccounts = () => {
    if (!baseUrl) return
    const requestId = ++accountsRequestId.current
    setAccountsLoading(true)
    setAccountsError('')
    setAccounts(null)
    fetchPlatformAccounts(baseUrl)
      .then((result) => {
        if (requestId === accountsRequestId.current) setAccounts(result.items)
      })
      .catch((error) => {
        if (requestId === accountsRequestId.current) {
          setAccounts(null)
          setAccountsError(
            `店铺发现失败：${describeApiError(error)}。为避免同步到错误店铺，已停止全部同步。`,
          )
        }
      })
      .finally(() => {
        if (requestId === accountsRequestId.current) setAccountsLoading(false)
      })
  }
  useEffect(() => {
    loadAccounts()
  }, [baseUrl])
  const loadSyncJobs = () => {
    if (!baseUrl) return
    setSyncJobsError('')
    fetchSyncJobs(baseUrl)
      .then(setSyncJobs)
      .catch((error) => setSyncJobsError(describeApiError(error)))
  }
  useEffect(() => {
    loadSyncJobs()
  }, [baseUrl])
  const loadBilling = () => {
    if (!baseUrl) return
    setBillingError('')
    fetchBillingStatus(baseUrl)
      .then(setBilling)
      .catch((error) => setBillingError(describeApiError(error)))
  }
  useEffect(() => {
    loadBilling()
  }, [baseUrl])
  const loadMetrics = () => {
    if (!baseUrl) return
    setMetricsError('')
    fetchWorkspaceMetrics(baseUrl)
      .then(setMetrics)
      .catch((error) => setMetricsError(describeApiError(error)))
  }
  useEffect(() => {
    loadMetrics()
  }, [baseUrl])
  const recharge = async () => {
    if (!baseUrl || rechargeSubmitting) return
    const amount = rechargeAmount.trim()
    const amountNumber = Number(amount)
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setRechargeError('充值金额必须是大于 0 的数字。')
      return
    }
    setRechargeSubmitting(true)
    setRechargeError('')
    try {
      const order = await createRechargeOrder(baseUrl, amount)
      setRechargeOrder({ ...order, amount_cny: order.amount_cny ?? amount })
      setRechargeOpen(false)
      if (order.payment_url?.startsWith('http'))
        window.open(order.payment_url, '_blank', 'noopener,noreferrer')
      loadBilling()
    } catch (error) {
      setRechargeError(describeApiError(error))
    } finally {
      setRechargeSubmitting(false)
    }
  }
  const queryRechargeOrder = async () => {
    if (!baseUrl || !rechargeOrder) return
    setRechargeQuerying(true)
    setBillingError('')
    try {
      const order = await fetchRechargeOrder(baseUrl, rechargeOrder.id)
      setRechargeOrder({ ...rechargeOrder, ...order })
      loadBilling()
    } catch (error) {
      setBillingError(describeApiError(error))
    } finally {
      setRechargeQuerying(false)
    }
  }
  const retryFailures = (job: SyncJob) => {
    if (!baseUrl || !job.failedItems.length) return
    setAction(`retry-${job.id}`)
    setActionError('')
    retrySyncFailures(
      baseUrl,
      job.id,
      job.failedItems.filter((item) => item.retryable).map((item) => item.id),
    )
      .then(loadSyncJobs)
      .catch((error) =>
        setActionError(`同步失败重试：${describeApiError(error)}`),
      )
      .finally(() => setAction(null))
  }
  const connect = (platform: PlatformId) => {
    if (!baseUrl) return
    setAction(platform)
    setActionError('')
    setActionMessage('')
    authorizePlatform(baseUrl, platform)
      .then((result) => {
        if (result.mode === 'fixture') {
          return completeFixtureAuthorization(
            baseUrl,
            platform,
            result.authorizationUrl,
          ).then(() => {
            setActionMessage(
              `${platformNames[platform]} 已完成演示授权，首轮同步已排队。`,
            )
            loadAccounts()
          })
        }
        if (result.authorizationUrl)
          window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
        loadAccounts()
        let attempts = 0
        const timer = window.setInterval(() => {
          attempts += 1
          loadAccounts()
          if (attempts >= 10) window.clearInterval(timer)
        }, 2000)
      })
      .catch((error) =>
        setActionError(`${platform}：${describeApiError(error)}`),
      )
      .finally(() => setAction(null))
  }
  const sync = (platform: PlatformId, accountId?: string) => {
    if (!baseUrl) return
    if (!accountId) {
      setActionError(
        `${platformNames[platform]}店铺缺少稳定的店铺 ID，未发起同步。`,
      )
      return
    }
    setAction(`sync-${platform}`)
    setActionError('')
    setActionMessage('')
    syncPlatform(baseUrl, platform, accountId)
      .then(() => setActionError(''))
      .catch((error) =>
        setActionError(
          `${platformNames[platform]}：${describeApiError(error)}`,
        ),
      )
      .finally(() => setAction(null))
  }
  const syncAll = async () => {
    if (!baseUrl) return
    const resolution = resolveStoreSyncTargets(accounts)
    if (!resolution.ok) {
      setActionError(resolution.message)
      return
    }
    setAction('sync-all')
    setActionError('')
    setActionMessage('')
    try {
      const results = await Promise.allSettled(
        resolution.targets.map((target) =>
          syncPlatform(baseUrl, target.platform, target.accountId),
        ),
      )
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [
              `${platformNames[resolution.targets[index].platform]} · ${resolution.targets[index].label}：${describeApiError(result.reason)}`,
            ]
          : [],
      )
      if (failures.length)
        setActionError(
          `部分店铺同步失败；未自动改选其他店铺。${failures.join('；')}`,
        )
      else
        setActionMessage(
          `已为 ${resolution.targets.length} 家店铺逐店发起同步。`,
        )
    } finally {
      setAction(null)
    }
  }
  const revoke = () => {
    if (!baseUrl || !revokeTarget) return
    const { platform, accountId } = revokeTarget
    setAction(`revoke-${platform}`)
    setActionError('')
    setActionMessage('')
    revokePlatform(baseUrl, platform, accountId)
      .then(() => {
        setRevokeTarget(null)
        loadAccounts()
      })
      .catch((error) =>
        setActionError(
          `${platformNames[platform]}：${describeApiError(error)}`,
        ),
      )
      .finally(() => setAction(null))
  }
  const apiRows = accounts?.map((account) => ({
    ...merchantConnectionPresentation(account),
    name: platformNames[account.platform] ?? account.platform,
    platformId: account.platform,
    accountId: account.accountId,
    shop:
      account.label ??
      account.alias ??
      account.storeName ??
      (account.accountId ? `店铺（${account.accountId}）` : '尚未绑定店铺'),
  }))
  const rows =
    apiRows ??
    (baseUrl
      ? []
      : platforms.map((platform) => ({
          ...platform,
          platform: platform.name,
          accountId: undefined,
        })))
  const connectedStoreCount = metrics
    ? String(
        metrics.stores.filter((store) => store.connection?.readable).length,
      )
    : baseUrl
      ? '—'
      : String(
          platforms.filter((platform) => platform.status === '演示已连接')
            .length,
        )
  const approvedCount = metrics ? String(metrics.taskFunnel.approved ?? 0) : '—'
  const riskCount = metrics ? String(metrics.riskSummary.total) : '—'
  const highRiskCount = metrics
    ? metrics.riskItems.filter((item) => item.severity === 'high').length
    : 0
  const workflowStatus = !baseUrl
    ? '离线演示'
    : metricsError
      ? '业务数据读取失败'
      : metrics
        ? '工作区数据已读取'
        : '正在读取业务数据'
  const liveActivity =
    syncJobs
      ?.slice(0, 4)
      .map(
        (job) =>
          [
            `${platformNames[job.platform] ?? job.platform}同步`,
            `${job.itemsReceived || job.itemsUpserted + job.itemsFailed} 项 · ${job.itemsFailed ? `${job.itemsFailed} 项失败` : '未发现失败项'}`,
            job.state === 'succeeded'
              ? '已完成'
              : job.state === 'failed'
                ? '处理失败'
                : '处理中',
          ] as [string, string, string],
      ) ?? []
  const capabilityStateLabel = (state: string) =>
    ({
      unverified: '未验证',
      documented: '已记录',
      fixture_verified: '演示通过',
      test_e2e: 'E2E 通过',
      production_canary: '生产 canary',
    })[state] ?? state
  const capabilityTone = (state: string) =>
    state === 'production_canary' || state === 'test_e2e'
      ? 'green'
      : state === 'unverified'
        ? 'amber'
        : 'blue'
  return (
    <div className="page-stack">
      <section className="welcome-panel">
        <div>
          <StatusChip
            tone={
              !baseUrl || metricsError ? 'amber' : metrics ? 'green' : 'blue'
            }
          >
            <Zap size={13} /> {workflowStatus}
          </StatusChip>
          <h2>
            把商品事实变成
            <br />
            可放心发布的内容
          </h2>
          <p>同步商品、确认事实、生成营销内容，并在发布前看清每一处变化。</p>
          <div className="button-row">
            <button
              className="primary"
              onClick={goTask}
              disabled={!baseUrl}
              title={
                !baseUrl
                  ? '连接 API 后才能选择商品并创建真实营销任务'
                  : undefined
              }
            >
              <Sparkles size={17} />
              {baseUrl ? '选择商品开始任务' : '连接 API 后选择商品'}
            </button>
            <button
              className="secondary"
              onClick={() => void syncAll()}
              disabled={
                !baseUrl ||
                accountsLoading ||
                Boolean(accountsError) ||
                accounts === null ||
                Boolean(action)
              }
            >
              <RefreshCw
                size={17}
                className={
                  action?.startsWith('sync-') || accountsLoading
                    ? 'spin'
                    : undefined
                }
              />
              {action?.startsWith('sync-')
                ? '同步中…'
                : accountsLoading
                  ? '正在发现店铺…'
                  : '同步全部店铺'}
            </button>
          </div>
        </div>
        <div className="flow-preview" aria-label="当前任务流程">
          <div className="flow-orbit">
            <span className="orbit-dot one" />
            <span className="orbit-dot two" />
            <div className="flow-center">
              <Sparkles size={25} />
              <b>AI</b>
            </div>
          </div>
          <div className="flow-caption">
            <span className="done">
              <Check size={14} />
              事实确认
            </span>
            <span className="active">内容生成</span>
            <span>检查发布</span>
          </div>
        </div>
      </section>

      <EntryPointCards onOpenEntry={onOpenEntry} />

      <section className="metric-grid" aria-label="关键运营指标">
        <MetricCard
          icon={Store}
          label="已连接店铺"
          value={connectedStoreCount}
          detail={
            metrics
              ? `${metrics.stores.length - Number(connectedStoreCount)} 家需处理或未就绪`
              : baseUrl
                ? '等待真实工作区数据'
                : '离线演示数据'
          }
          tone="green"
        />
        <MetricCard
          icon={FileCheck2}
          label="已批准内容"
          value={approvedCount}
          detail={
            metrics
              ? '当前工作区累计'
              : baseUrl
                ? '等待真实工作区数据'
                : '离线演示数据'
          }
          tone="blue"
        />
        <MetricCard
          icon={Clock3}
          label="平均首稿耗时"
          value="—"
          detail="当前接口暂无耗时统计"
          tone="violet"
        />
        <MetricCard
          icon={AlertCircle}
          label="需处理问题"
          value={riskCount}
          detail={
            metrics
              ? `其中 ${highRiskCount} 项高风险`
              : baseUrl
                ? '等待真实工作区数据'
                : '离线演示数据'
          }
          tone="amber"
        />
      </section>

      {metricsError && (
        <ErrorNotice
          message={`运营指标：${metricsError}`}
          onRetry={loadMetrics}
          compact
        />
      )}

      {baseUrl && metrics && (
        <section
          className="panel issue-queue-panel"
          aria-labelledby="issue-queue-title"
        >
          <div className="panel-heading">
            <div>
              <span className="section-kicker">ACTION QUEUE</span>
              <h3 id="issue-queue-title">优先处理的问题</h3>
            </div>
            <button className="text-button" onClick={goProducts}>
              查看商品与问题 <ArrowRight size={14} />
            </button>
          </div>
          {metrics.riskItems.length ? (
            <div className="issue-queue-list">
              {metrics.riskItems.slice(0, 3).map((item, index) => (
                <article
                  className="issue-queue-item"
                  key={`${item.type}-${item.platform ?? 'workspace'}-${item.storeName ?? ''}-${index}`}
                >
                  <div className="issue-queue-rank">{index + 1}</div>
                  <div className="issue-queue-copy">
                    <b>{item.title ?? item.type}</b>
                    <span>
                      {[
                        item.platform ? platformNames[item.platform] : '',
                        item.storeName ?? '',
                        item.status ?? '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || '当前工作区'}
                    </span>
                    <small>
                      {item.nextAction ?? '打开商品与任务查看处理方式'}
                    </small>
                  </div>
                  <button className="secondary" onClick={goProducts}>
                    查看并处理
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <CheckCircle2 size={18} />
              暂无需要你处理的问题
            </div>
          )}
          {metrics.riskSummary.total > 3 && (
            <small className="issue-queue-more">
              还有 {metrics.riskSummary.total - 3} 项问题，已按优先级排序。
            </small>
          )}
        </section>
      )}

      {baseUrl && (
        <section className="panel wallet-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">PLUGIN WALLET</span>
              <h3>钱包与能力状态</h3>
            </div>
            <StatusChip
              tone={
                billing?.capability_entitlements?.balance.state === 'available'
                  ? 'green'
                  : 'amber'
              }
            >
              {billing?.capability_entitlements?.balance.label ?? '读取中…'}
            </StatusChip>
          </div>
          {billingError && (
            <ErrorNotice message={billingError} onRetry={loadBilling} compact />
          )}
          <div className="wallet-content">
            <div>
              <strong className="wallet-balance">
                ¥{billing?.balance_cny ?? '—'}
              </strong>
              <p>{billing?.model_access.message ?? '正在读取钱包状态…'}</p>
              <small>
                余额、套餐额度、生成和平台发布分别判断；支付订单只有回调确认后才会到账。
              </small>
            </div>
            {billing?.capability_entitlements?.balance.state !==
              'available' && (
              <button
                className="primary"
                onClick={() => {
                  setRechargeAmount('100')
                  setRechargeError('')
                  setRechargeOpen(true)
                }}
              >
                创建充值订单
              </button>
            )}
          </div>
          {billing?.capability_entitlements && (
            <div className="wallet-entitlement-grid" aria-label="能力状态">
              {Object.entries(billing.capability_entitlements).map(
                ([id, item]) => (
                  <div className="wallet-entitlement" key={id}>
                    <b>
                      {(
                        {
                          balance: '余额',
                          package_quota: '套餐剩余次数',
                          generation: '生成能力',
                          platform_publish: '平台发布能力',
                        } as Record<string, string>
                      )[id] ?? id}
                    </b>
                    <StatusChip
                      tone={item.state === 'available' ? 'green' : 'amber'}
                    >
                      {item.label}
                    </StatusChip>
                    <small>
                      {item.reason}
                      {'platform' in item && item.platform
                        ? `（${item.platform} · ${item.store ?? '店铺'}）`
                        : ''}
                    </small>
                  </div>
                ),
              )}
            </div>
          )}
          {rechargeOrder && (
            <div className="recharge-order-card" role="status">
              <div className="recharge-order-head">
                <div>
                  <span className="section-kicker">RECHARGE ORDER</span>
                  <b>充值订单</b>
                </div>
                <StatusChip
                  tone={rechargeOrder.state === 'paid' ? 'green' : 'amber'}
                >
                  {rechargeOrder.state === 'paid'
                    ? '已到账'
                    : rechargeOrder.state === 'pending'
                      ? '待支付 / 待回调'
                      : rechargeOrder.state}
                </StatusChip>
              </div>
              <div className="recharge-order-meta">
                <span>
                  订单号 <b>{rechargeOrder.id}</b>
                </span>
                <span>
                  金额 <b>¥{rechargeOrder.amount_cny ?? '—'}</b>
                </span>
                <span>
                  渠道{' '}
                  <b>
                    {rechargeOrder.channel === 'wechat' ? '微信支付' : '支付宝'}
                  </b>
                </span>
              </div>
              {rechargeOrder.payment_mode === 'fixture' ||
              rechargeOrder.paymentMode === 'fixture' ||
              rechargeOrder.payment_url?.startsWith('fixture:') ||
              rechargeOrder.paymentUrl?.startsWith('fixture:') ? (
                <p className="recharge-mock-note">
                  当前为 Mock
                  演示订单，不会产生真实扣款。点击“查询订单”可验证订单状态。
                </p>
              ) : (
                rechargeOrder.warning && (
                  <p className="recharge-mock-note">{rechargeOrder.warning}</p>
                )
              )}
              <div className="button-row">
                <button
                  className="secondary"
                  onClick={queryRechargeOrder}
                  disabled={rechargeQuerying}
                >
                  {rechargeQuerying ? '查询中…' : '查询订单'}
                </button>
                {(rechargeOrder.payment_url?.startsWith('http') ||
                  rechargeOrder.paymentUrl?.startsWith('http')) && (
                  <button
                    className="text-button"
                    onClick={() =>
                      window.open(
                        rechargeOrder.payment_url ?? rechargeOrder.paymentUrl,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                  >
                    打开支付页面 <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="dashboard-grid">
        <article className="panel platform-panel" aria-busy={accountsLoading}>
          <div className="panel-heading">
            <div>
              <span className="section-kicker">CONNECTIONS</span>
              <h3>平台连接</h3>
            </div>
            <button className="text-button" onClick={goProducts}>
              管理连接 <ArrowRight size={15} />
            </button>
          </div>
          {accountsLoading && <LoadingState label="正在读取平台连接…" />}
          {accountsError && (
            <ErrorNotice
              message={accountsError}
              onRetry={loadAccounts}
              compact
            />
          )}
          {actionError && <ErrorNotice message={actionError} compact />}
          {actionMessage && (
            <div className="info-notice" role="status">
              <CheckCircle2 size={15} />
              {actionMessage}
            </div>
          )}
          <div className="platform-list">
            {rows.map((platform) => (
              <div
                className="platform-row"
                key={`${platform.platformId}-${platform.accountId ?? 'unbound'}`}
              >
                <div className={`platform-logo ${platform.tone}`}>
                  {platform.name.slice(0, 1)}
                </div>
                <div className="platform-meta">
                  <b>{platform.name}</b>
                  <span>{platform.shop}</span>
                </div>
                <div className="platform-sync">
                  <StatusChip
                    tone={platform.tone === 'green' ? 'green' : 'amber'}
                  >
                    {platform.status}
                  </StatusChip>
                  <small>{platform.sync}</small>
                </div>
                {baseUrl ? (
                  <>
                    {platform.canSync && (
                      <button
                        className="text-button"
                        onClick={() =>
                          sync(platform.platformId, platform.accountId)
                        }
                        disabled={Boolean(action)}
                      >
                        {action === `sync-${platform.platformId}`
                          ? '同步中…'
                          : '同步'}
                      </button>
                    )}
                    {platform.accountId && platform.status === '可读取' && (
                      <button
                        className="text-button danger"
                        onClick={() =>
                          setRevokeTarget({
                            platform: platform.platformId,
                            accountId: platform.accountId!,
                            label: platform.shop,
                          })
                        }
                        disabled={Boolean(action)}
                      >
                        {action === `revoke-${platform.platformId}`
                          ? '撤销中…'
                          : '撤销'}
                      </button>
                    )}
                    {!platform.canSync &&
                      (!platform.accountId || platform.canReauthorize) && (
                        <button
                          className="text-button"
                          onClick={() => connect(platform.platformId)}
                          disabled={Boolean(action)}
                        >
                          {action === platform.platformId
                            ? '处理中…'
                            : platform.canReauthorize
                              ? '重新授权'
                              : '连接'}
                        </button>
                      )}
                  </>
                ) : (
                  <button
                    className="icon-button"
                    onClick={() => onOpenUtility('help')}
                    aria-label={`查看${platform.name}连接详情`}
                  >
                    <ChevronDown size={17} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </article>
        <article className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">RECENT</span>
              <h3>最近动态</h3>
            </div>
            <button className="text-button" onClick={goTasks}>
              查看全部
            </button>
          </div>
          <div className="activity-list">
            {!baseUrl &&
              activity.map(([title, detail, time], index) => (
                <div className="activity-row" key={title}>
                  <span className={`activity-symbol a${index}`}>
                    <Check size={14} />
                  </span>
                  <div>
                    <b>{title}</b>
                    <span>{detail}</span>
                  </div>
                  <time>{time}</time>
                </div>
              ))}
            {baseUrl && syncJobs === null && (
              <LoadingState label="正在读取真实同步动态…" />
            )}
            {baseUrl &&
              syncJobs !== null &&
              !syncJobsError &&
              liveActivity.map(([title, detail, time], index) => (
                <div className="activity-row" key={`${title}-${index}`}>
                  <span className={`activity-symbol a${index}`}>
                    <Check size={14} />
                  </span>
                  <div>
                    <b>{title}</b>
                    <span>{detail}</span>
                  </div>
                  <time>{time}</time>
                </div>
              ))}
            {baseUrl &&
              syncJobs !== null &&
              !syncJobsError &&
              liveActivity.length === 0 && (
                <div className="empty-state">
                  <PackageSearch size={18} />
                  暂无真实同步动态
                </div>
              )}
            {baseUrl && syncJobsError && (
              <ErrorNotice
                message={`最近动态读取失败：${syncJobsError}`}
                onRetry={loadSyncJobs}
                compact
              />
            )}
          </div>
        </article>
      </section>
      {baseUrl && (
        <section className="panel sync-failures-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">SYNC RECOVERY</span>
              <h3>同步任务与失败项</h3>
            </div>
            <button className="text-button" onClick={loadSyncJobs}>
              <RefreshCw size={14} />
              刷新
            </button>
          </div>
          {syncJobsError && (
            <ErrorNotice
              message={syncJobsError}
              onRetry={loadSyncJobs}
              compact
            />
          )}
          {!syncJobsError && syncJobs?.length === 0 && (
            <div className="empty-state">
              <CheckCircle2 size={18} />
              暂无同步任务
            </div>
          )}
          {syncJobs
            ?.filter((job) => job.itemsFailed > 0)
            .map((job) => (
              <div className="sync-failure-row" key={job.id}>
                <div>
                  <b>
                    {platformNames[job.platform] ?? job.platform} · {job.id}
                  </b>
                  <span>
                    {job.itemsFailed} 项失败 ·{' '}
                    {job.failedItems[0]?.message ?? '请查看失败详情'}
                  </span>
                </div>
                <StatusChip tone="amber">{job.state}</StatusChip>
                <button
                  className="text-button"
                  onClick={() => retryFailures(job)}
                  disabled={
                    Boolean(action) ||
                    !job.failedItems.some((item) => item.retryable)
                  }
                >
                  {action === `retry-${job.id}` ? '重试中…' : '重试失败项'}
                </button>
              </div>
            ))}
          {syncJobs &&
            syncJobs.length > 0 &&
            syncJobs.every((job) => job.itemsFailed === 0) && (
              <div className="empty-state">
                <CheckCircle2 size={18} />
                当前同步任务没有失败项
              </div>
            )}
        </section>
      )}
      <section className="panel capability-panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">CAPABILITY EVIDENCE</span>
            <h3>平台能力证据</h3>
          </div>
        </div>
        <div className="info-notice capability-note">
          <CircleHelp size={15} />
          平台能力证据属于平台运营工作台；商家工作台仅展示店铺授权和交付就绪状态。
        </div>
      </section>
      {rechargeOpen && (
        <DialogFrame
          testId="recharge-dialog"
          kicker="WALLET RECHARGE"
          title="充值并解锁能力"
          onClose={() => setRechargeOpen(false)}
          busy={rechargeSubmitting}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setRechargeOpen(false)}
                disabled={rechargeSubmitting}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => void recharge()}
                disabled={rechargeSubmitting}
              >
                {rechargeSubmitting ? '正在创建订单…' : '创建充值订单'}
              </button>
            </>
          }
        >
          <div className="dialog-form">
            <label htmlFor="recharge-amount">
              充值金额（元）
              <input
                id="recharge-amount"
                data-dialog-initial-focus
                inputMode="decimal"
                value={rechargeAmount}
                onChange={(event) => {
                  setRechargeAmount(event.target.value)
                  setRechargeError('')
                }}
              />
            </label>
            <small>
              提交后会创建订单；只有支付服务回调确认后余额才会到账。
            </small>
            {rechargeError && <ErrorNotice message={rechargeError} compact />}
          </div>
        </DialogFrame>
      )}
      {revokeTarget && (
        <DialogFrame
          testId="revoke-platform-dialog"
          kicker="CONNECTION SAFETY"
          title={`撤销${platformNames[revokeTarget.platform]}连接`}
          onClose={() => setRevokeTarget(null)}
          busy={action === `revoke-${revokeTarget.platform}`}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setRevokeTarget(null)}
                disabled={Boolean(action)}
              >
                取消
              </button>
              <button
                className="danger-action"
                onClick={revoke}
                disabled={Boolean(action)}
              >
                {action ? '撤销中…' : '确认撤销连接'}
              </button>
            </>
          }
        >
          <p>
            将立即停止“{revokeTarget.label}
            ”的同步和发布，但保留已有商品快照与审计记录。
          </p>
          {actionError && <ErrorNotice message={actionError} compact />}
        </DialogFrame>
      )}
    </div>
  )
}

const platformLabel: Record<string, string> = {
  jd: '京东',
  taobao: '淘宝',
  tmall: '天猫',
  pinduoduo: '拼多多',
  xiaohongshu: '小红书',
  douyin: '抖音',
}
const productSourceLabel = (source: string) =>
  source === 'official_api'
    ? '官方 API'
    : source === 'fixture' || source === 'example'
      ? '演示数据'
      : source === 'local_import' || source === 'merchant_import'
        ? '商家导入'
        : '服务端数据'

type Target = {
  productId: string
  platform: PlatformId
  title: string
  remoteId?: string
  accountId?: string
  storeName?: string
  listingId?: string
  taskId?: string
  taskIntentKey?: string
  resolvedTask?: Task
  resolvedProduct?: ApiProduct
}

const taskCreationRequests = new Map<string, Promise<Task>>()

function createTaskOnce(
  baseUrl: string,
  target: Target,
  requestText?: string,
): Promise<Task> {
  const intentKey = target.taskIntentKey ?? crypto.randomUUID()
  const lockKey = `${baseUrl}:${target.productId}:${target.platform}:${target.accountId ?? ''}:${intentKey}`
  const active = taskCreationRequests.get(lockKey)
  if (active) return active
  const request = createTask(baseUrl, {
    product_id: target.productId,
    platform: target.platform,
    ...(target.accountId ? { account_id: target.accountId } : {}),
    ...(requestText?.trim() ? { request_text: requestText.trim() } : {}),
    idempotency_key: intentKey,
  }).finally(() => {
    if (taskCreationRequests.get(lockKey) === request)
      taskCreationRequests.delete(lockKey)
  })
  taskCreationRequests.set(lockKey, request)
  return request
}

async function resolveMerchantRouteTarget(
  baseUrl: string,
  routeTarget: MerchantRouteTarget,
): Promise<Target> {
  if (routeTarget.kind === 'task') {
    const task = await fetchTask(baseUrl, routeTarget.taskId)
    const product = assertProductTargetIdentity(
      await fetchProduct(baseUrl, task.productId),
      {
        productId: task.productId,
        platform: task.platform,
        accountId: task.accountId,
      },
    )
    const target = {
      productId: product.id,
      platform: product.platform,
      title: product.title,
      remoteId: product.remoteId,
      accountId: product.accountId,
      storeName: product.storeName,
      taskId: task.id,
      resolvedTask: task,
      resolvedProduct: product,
    }
    const identityError =
      validateProductStoreIdentity(target, product) ??
      validateTaskStoreIdentity(target, task)
    if (identityError) throw new Error(identityError)
    return target
  }
  const fetchedProduct = await fetchProduct(baseUrl, routeTarget.productId)
  const product = assertProductTargetIdentity(fetchedProduct, {
    productId: routeTarget.productId,
    platform: fetchedProduct.platform,
  })
  if (routeTarget.platform && routeTarget.platform !== product.platform)
    throw new Error('深链平台与当前商品平台不一致，已阻止创建任务。')
  if (routeTarget.accountId && routeTarget.accountId !== product.accountId)
    throw new Error('深链店铺账号与当前商品账号不一致，已阻止创建任务。')
  const target = {
    productId: product.id,
    platform: product.platform,
    title: product.title,
    remoteId: product.remoteId,
    accountId: product.accountId,
    storeName: product.storeName,
    taskIntentKey: routeTarget.intentKey ?? crypto.randomUUID(),
  }
  const identityError = validateProductStoreIdentity(target, product)
  if (identityError) throw new Error(identityError)
  return target
}

function AssetProductUsageDialog({
  baseUrl,
  asset,
  onClose,
}: {
  baseUrl: string
  asset: AssetMetadata
  onClose: () => void
}) {
  const [bindings, setBindings] = useState<ProductAssetBinding[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void fetchProductsByAsset(baseUrl, asset.id)
      .then((result) => {
        if (active) setBindings(result.items)
      })
      .catch((cause) => {
        if (active) setError(describeApiError(cause))
      })
    return () => {
      active = false
    }
  }, [asset.id, baseUrl])
  return (
    <DialogFrame
      testId="asset-product-usage-dialog"
      kicker="ASSET · PRODUCT USAGE"
      title={`“${asset.name}”被哪些商品使用`}
      onClose={onClose}
      actions={
        <button className="primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <p className="panel-subtitle">
        只展示服务端关系 API
        返回的绑定，不会通过文件名、图片或全量扫描推断使用关系。
      </p>
      {!bindings && !error && <LoadingState label="正在读取素材使用关系…" />}
      {error && (
        <ErrorNotice
          message={`素材使用关系读取失败：${error}`}
          onRetry={() => {
            setBindings(null)
            setError('')
          }}
        />
      )}
      {bindings && !bindings.length && (
        <div className="empty-state">
          <PackageSearch size={20} />
          <b>暂无商品绑定</b>
          <span>该素材尚未被服务端记录为任何商品的来源素材。</span>
        </div>
      )}
      {bindings && bindings.length > 0 && (
        <div className="relation-list" aria-label="使用该素材的商品列表">
          {bindings.map((binding) => (
            <div
              className="relation-row"
              key={`${binding.productId}:${binding.assetRole}:${binding.ordinal}`}
            >
              <div>
                <b>商品关系已读取</b>
                <span>
                  {binding.assetRole === 'main'
                    ? '主图'
                    : binding.assetRole === 'detail'
                      ? '详情图'
                      : binding.assetRole === 'source'
                        ? '来源素材'
                        : '参考素材'}{' '}
                  · 已确认绑定
                </span>
              </div>
              <StatusChip
                tone={binding.status === 'active' ? 'green' : 'amber'}
              >
                {binding.status === 'active' ? '已绑定' : '待确认'}
              </StatusChip>
            </div>
          ))}
        </div>
      )}
    </DialogFrame>
  )
}

function AssetLibrary({
  baseUrl,
  initialEntry = 'assets',
}: {
  baseUrl?: string
  initialEntry?: Exclude<MerchantEntryPoint, 'products'>
}) {
  const [assets, setAssets] = useState<AssetMetadata[] | null>(null)
  const [storageQuota, setStorageQuota] = useState<StorageQuotaProjection | null>(null)
  const [assetPreviews, setAssetPreviews] = useState<Record<string, string>>({})
  const [assetStorageReady, setAssetStorageReady] = useState(false)
  const [brand, setBrand] = useState<BrandProfile | null>(null)
  const [extraction, setExtraction] = useState<BrandExtraction | null>(null)
  const [selectedBrandFields, setSelectedBrandFields] = useState<
    BrandCandidateFieldKey[]
  >([])
  const [selectedAlternatives, setSelectedAlternatives] = useState<
    Partial<Record<BrandCandidateFieldKey, number>>
  >({})
  const [brandAction, setBrandAction] = useState('')
  const [brandMessage, setBrandMessage] = useState('')
  const [brandLoadError, setBrandLoadError] = useState('')
  const [storageLoadError, setStorageLoadError] = useState('')
  const [preferenceAssetId, setPreferenceAssetId] = useState('')
  const [preferenceVerdict, setPreferenceVerdict] = useState<
    'excellent' | 'disliked'
  >('excellent')
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
  const [visualFontLicense, setVisualFontLicense] = useState<
    'approved' | 'restricted' | 'unknown'
  >('unknown')
  const [visualStyles, setVisualStyles] = useState('')
  const [restrictedPeople, setRestrictedPeople] = useState('')
  const [restrictedSpokespersons, setRestrictedSpokespersons] = useState('')
  const [restrictedIps, setRestrictedIps] = useState('')
  const [restrictedContent, setRestrictedContent] = useState('')
  const [logoRecolor, setLogoRecolor] = useState(false)
  const [logoDistortion, setLogoDistortion] = useState(false)
  const [logoRedraw, setLogoRedraw] = useState(false)
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [assetEntry, setAssetEntry] =
    useState<Exclude<MerchantEntryPoint, 'products'>>(initialEntry)
  const [error, setError] = useState('')
  const uploadInput = useRef<HTMLInputElement>(null)
  const [uploadAction, setUploadAction] = useState('')
  const [rightsAsset, setRightsAsset] = useState<AssetMetadata | null>(null)
  const [rightsScope, setRightsScope] = useState('commercial_authorized')
  const [factsAsset, setFactsAsset] = useState<AssetMetadata | null>(null)
  const [factsJson, setFactsJson] = useState('')
  const [factsReason, setFactsReason] = useState('商家已核对原始资料')
  const [assetDialogError, setAssetDialogError] = useState('')
  const [usageAsset, setUsageAsset] = useState<AssetMetadata | null>(null)
  useEffect(() => {
    setAssetEntry(initialEntry)
  }, [initialEntry])
  const visibleAssets =
    assets?.filter((asset) => assetMatchesEntry(asset.mimeType, assetEntry)) ??
    []
  const load = async () => {
    if (!baseUrl) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    setBrandLoadError('')
    setStorageLoadError('')
    const [assetResult, brandResult, healthResult, quotaResult] = await Promise.allSettled([
      fetchAssets(baseUrl),
      fetchBrandProfile(baseUrl),
      fetchApiHealth(baseUrl),
      fetchAssetStorageQuota(baseUrl),
    ])
    if (assetResult.status === 'fulfilled') setAssets(assetResult.value)
    else setError(describeApiError(assetResult.reason))
    if (brandResult.status === 'fulfilled') setBrand(brandResult.value.profile)
    else setBrandLoadError(describeApiError(brandResult.reason))
    if (healthResult.status === 'fulfilled')
      setAssetStorageReady(
        healthResult.value?.setup?.objectStorage?.configured === true,
      )
    else {
      setAssetStorageReady(false)
      setStorageLoadError(describeApiError(healthResult.reason))
    }
    if (quotaResult.status === 'fulfilled') setStorageQuota(quotaResult.value ?? null)
    else setStorageQuota(null)
    setLoading(false)
  }
  const loadBrand = () => {
    if (!baseUrl) return
    setBrandLoadError('')
    fetchBrandProfile(baseUrl)
      .then((result) => setBrand(result.profile))
      .catch((cause) => setBrandLoadError(describeApiError(cause)))
  }
  const loadStorageHealth = () => {
    if (!baseUrl) return
    setStorageLoadError('')
    fetchApiHealth(baseUrl)
      .then((health) =>
        setAssetStorageReady(health?.setup?.objectStorage?.configured === true),
      )
      .catch((cause) => {
        setAssetStorageReady(false)
        setStorageLoadError(describeApiError(cause))
      })
  }
  useEffect(() => {
    void load()
  }, [baseUrl])
  useEffect(() => {
    // Preview bytes are fetched only after the merchant explicitly chooses
    // “打开并阅读”. This keeps expired/quarantined objects from generating a
    // wall of failed requests while the asset catalog is being scanned.
    setAssetPreviews({})
  }, [assets])
  useEffect(() => {
    const rules = brand?.visualRules
    setVisualLogoIds(rules?.logo?.assetIds ?? [])
    setLogoRecolor(rules?.logo?.allowRecolor ?? false)
    setLogoDistortion(rules?.logo?.allowDistortion ?? false)
    setLogoRedraw(rules?.logo?.allowRedraw ?? false)
    setVisualPrimary(rules?.colors?.primary.join(', ') ?? '')
    setVisualSecondary(rules?.colors?.secondary.join(', ') ?? '')
    setVisualForbidden(rules?.colors?.forbidden.join(', ') ?? '')
    setVisualFonts(rules?.fonts?.map((font) => font.family).join(', ') ?? '')
    setVisualFontLicense(rules?.fonts?.[0]?.licenseStatus ?? 'unknown')
    setVisualStyles(rules?.styleKeywords?.join(', ') ?? '')
    setRestrictedPeople(rules?.restrictedSubjects?.people.join(', ') ?? '')
    setRestrictedSpokespersons(
      rules?.restrictedSubjects?.spokespersons.join(', ') ?? '',
    )
    setRestrictedIps(
      rules?.restrictedSubjects?.intellectualProperties.join(', ') ?? '',
    )
    setRestrictedContent(
      rules?.restrictedSubjects?.prohibitedContent.join(', ') ?? '',
    )
  }, [brand?.revision])
  const uploadFiles = async (files: FileList | null) => {
    if (!baseUrl || !files?.length) return
    const selected = Array.from(files)
    if (selected.some((file) => file.size === 0)) {
      setBrandMessage('不能上传空文件。')
      return
    }
    if (selected.some((file) => file.size > 50 * 1024 * 1024)) {
      setBrandMessage('单个素材不能超过 50MB。')
      return
    }
    setUploadAction(`正在上传 1/${selected.length}…`)
    setBrandMessage('')
    try {
      for (const [index, file] of selected.entries()) {
        setUploadAction(`正在上传 ${index + 1}/${selected.length}…`)
        await uploadAsset(baseUrl, file)
      }
      await load()
      setBrandMessage(
        `已上传 ${selected.length} 个素材；当前处于隔离区，完成安全扫描与权益确认后才能用于生成。`,
      )
    } catch (cause) {
      setBrandMessage(describeApiError(cause))
    } finally {
      setUploadAction('')
      if (uploadInput.current) uploadInput.current.value = ''
    }
  }
  const extractBrand = async () => {
    if (!baseUrl) return
    setBrandAction('正在提取品牌字段…')
    setBrandMessage('')
    try {
      const result = await extractBrandProfile(
        baseUrl,
        assets
          ?.filter((asset) => asset.parseStatus === 'succeeded')
          .map((asset) => asset.id),
      )
      setExtraction(result)
      setSelectedBrandFields([])
      setSelectedAlternatives({})
      setBrandMessage(
        Object.keys(result.fields).length
          ? '候选字段尚未写入，请逐项核对并勾选确认。'
          : (result.warnings[0] ?? '没有识别到候选字段。'),
      )
    } catch (cause) {
      setBrandMessage(describeApiError(cause))
    } finally {
      setBrandAction('')
    }
  }
  const confirmBrand = async () => {
    if (!baseUrl || !extraction || !selectedBrandFields.length) return
    const selected = Object.fromEntries(
      selectedBrandFields.map((key) => [
        key,
        extraction.fields[key]?.alternatives[selectedAlternatives[key] ?? 0]
          ?.value ?? extraction.fields[key]?.value,
      ]),
    ) as Partial<Record<BrandCandidateFieldKey, string | string[]>>
    const name = typeof selected.name === 'string' ? selected.name : brand?.name
    if (!name) {
      setBrandMessage('首次建档必须确认“品牌名称”。')
      return
    }
    const detailKeys = ['logoRules', 'colors', 'fonts', 'rights'] as const
    const details = Object.fromEntries(
      detailKeys
        .filter((key) => selectedBrandFields.includes(key))
        .map((key) => [key, selected[key]]),
    )
    const resolutions = Object.fromEntries([
      ...selectedBrandFields
        .filter(
          (key) => !detailKeys.includes(key as (typeof detailKeys)[number]),
        )
        .map((key) => [key, 'candidate']),
      ...(Object.keys(details).length ? [['details', 'candidate']] : []),
    ]) as Record<string, 'candidate'>
    setBrandAction('正在保存已确认字段…')
    setBrandMessage('')
    try {
      const saved = await saveBrandProfile(baseUrl, {
        name,
        ...(typeof selected.positioning === 'string'
          ? { positioning: selected.positioning }
          : {}),
        ...(typeof selected.audience === 'string'
          ? { audience: selected.audience }
          : {}),
        ...(Array.isArray(selected.tone) ? { tone: selected.tone } : {}),
        ...(Array.isArray(selected.forbiddenTerms)
          ? { forbidden_terms: selected.forbiddenTerms }
          : {}),
        ...(Object.keys(details).length
          ? { details: { ...(brand?.details ?? {}), ...details } }
          : {}),
        source: `brand.extract:${extraction.assetIds.join(',')}`,
        conflict_resolutions: resolutions,
      })
      setBrand(saved)
      setExtraction(null)
      setSelectedBrandFields([])
      setBrandMessage(
        `品牌档案 r${saved.revision} 已保存；未勾选字段没有写入。`,
      )
    } catch (cause) {
      setBrandMessage(describeApiError(cause))
    } finally {
      setBrandAction('')
    }
  }
  const toggleBrandField = (key: BrandCandidateFieldKey) =>
    setSelectedBrandFields((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    )
  const displayBrandValue = (value: string | string[]) =>
    Array.isArray(value) ? value.join('、') : value
  const splitValues = (value: string) =>
    value
      .split(/[,，\n]/u)
      .map((item) => item.trim())
      .filter(Boolean)
  const openPreferenceEditor = (asset: AssetMetadata) => {
    setPreferenceAssetId(asset.id)
    setPreferenceVerdict(asset.preference?.verdict ?? 'excellent')
    setPreferenceReasons(asset.preference?.reasons.join('，') ?? '')
    setPreferenceNote(asset.preference?.note ?? '')
    setBrandMessage('')
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
    if (!reasons.length) {
      setBrandMessage('评价历史素材必须填写至少一条具体原因。')
      return
    }
    setPreferenceAction('正在保存素材评价…')
    setBrandMessage('')
    try {
      const saved = await saveAssetPreference(baseUrl, asset.id, {
        verdict: preferenceVerdict,
        reasons,
        ...(preferenceNote.trim() ? { note: preferenceNote.trim() } : {}),
        expected_revision: asset.revision,
      })
      setAssets(
        (current) =>
          current?.map((item) => (item.id === saved.id ? saved : item)) ?? null,
      )
      setPreferenceAssetId('')
      setBrandMessage(
        saved.preference?.verdict === 'excellent'
          ? `已将“${saved.name}”标记为优秀素材；仅在扫描、权益和平台条件满足时进入后续任务参考快照。`
          : `已将“${saved.name}”标记为不喜欢素材；后续任务会排除该素材，显式选择时将被阻止。`,
      )
    } catch (cause) {
      setBrandMessage(describeApiError(cause))
    } finally {
      setPreferenceAction('')
    }
  }
  const clearPreference = async (asset: AssetMetadata) => {
    if (!baseUrl) return
    setPreferenceAction('正在清除评价…')
    setBrandMessage('')
    try {
      const saved = await saveAssetPreference(baseUrl, asset.id, {
        verdict: 'unrated',
        expected_revision: asset.revision,
      })
      setAssets(
        (current) =>
          current?.map((item) => (item.id === saved.id ? saved : item)) ?? null,
      )
      setPreferenceAssetId('')
      setBrandMessage(`已清除“${saved.name}”的历史素材评价。`)
    } catch (cause) {
      setBrandMessage(describeApiError(cause))
    } finally {
      setPreferenceAction('')
    }
  }
  const confirmRights = async () => {
    if (!baseUrl || !rightsAsset) return
    const asset = rightsAsset
    if (resolveAssetPrimaryStatus(asset).action !== 'confirm_rights') {
      setBrandMessage('当前素材状态已变化，请先刷新状态后再确认权益。')
      return
    }
    if (asset.scanStatus !== 'clean') {
      setBrandMessage(
        '素材必须先由安全扫描服务标记为 clean，不能在页面内伪造扫描结果。',
      )
      return
    }
    setAssetAction(`rights-${asset.id}`)
    setBrandMessage('')
    try {
      const saved = await updateAssetRights(baseUrl, asset.id, {
        rights_status: 'approved',
        rights_scope: rightsScope,
        usage_scopes: ['commercial', 'ai_generation'],
        ai_modification_allowed: false,
      })
      setAssets(
        (current) =>
          current?.map((item) => (item.id === saved.id ? saved : item)) ?? null,
      )
      setBrandMessage(
        `已确认“${saved.name}”的商用权益；如需改图，仍需单独确认 AI 修改许可。`,
      )
      setRightsAsset(null)
    } catch (cause) {
      setAssetDialogError(describeApiError(cause))
    } finally {
      setAssetAction('')
    }
  }
  const confirmFacts = async () => {
    if (!baseUrl || !factsAsset) return
    const asset = factsAsset
    if (
      resolveAssetPrimaryStatus(asset).action !== 'confirm_facts' &&
      resolveAssetPrimaryStatus(asset).action !== 'manual_review'
    ) {
      setAssetDialogError(
        '当前素材状态不允许确认事实，请先完成前置步骤或刷新状态。',
      )
      return
    }
    if (asset.scanStatus !== 'clean') {
      setAssetDialogError('素材必须先完成安全扫描。')
      return
    }
    let facts: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(factsJson)
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !Object.keys(parsed).length
      )
        throw new Error('empty')
      facts = parsed as Record<string, unknown>
    } catch {
      setAssetDialogError('事实必须是非空 JSON 对象，未保存。')
      return
    }
    const reason = factsReason.trim()
    if (!reason) {
      setAssetDialogError('请填写核对来源或确认原因。')
      return
    }
    setAssetAction(`facts-${asset.id}`)
    setBrandMessage('')
    try {
      const saved = await confirmAssetFacts(baseUrl, asset.id, facts, reason)
      setAssets(
        (current) =>
          current?.map((item) => (item.id === saved.id ? saved : item)) ?? null,
      )
      setBrandMessage(
        `已人工确认“${saved.name}”的素材事实；后续会保留 manual 来源。`,
      )
      setFactsAsset(null)
    } catch (cause) {
      setAssetDialogError(describeApiError(cause))
    } finally {
      setAssetAction('')
    }
  }
  const parse = async (asset: AssetMetadata) => {
    if (!baseUrl || asset.scanStatus !== 'clean') return
    if (resolveAssetPrimaryStatus(asset).action !== 'parse') {
      setBrandMessage('当前素材正在读取或状态未就绪，请刷新状态后再操作。')
      return
    }
    setAssetAction(`parse-${asset.id}`)
    setBrandMessage('')
    try {
      const parsed = await parseAsset(baseUrl, asset.id)
      setAssets(
        (current) =>
          current?.map((item) => (item.id === parsed.id ? parsed : item)) ??
          null,
      )
      setBrandMessage(
        parsed.parseStatus === 'succeeded'
          ? `“${parsed.name}”已完成事实解析；如需作为可用事实，还要确认解析结果。`
          : `“${parsed.name}”解析未完成，请使用人工事实确认。`,
      )
    } catch (cause) {
      setBrandMessage(describeApiError(cause))
    } finally {
      setAssetAction('')
    }
  }
  const runPrimaryAssetAction = (asset: AssetMetadata) => {
    const action = resolveAssetPrimaryAction(asset, {
      configured: Boolean(baseUrl),
      busy: Boolean(assetAction),
    })
    if (action.disabled) return
    if (action.kind === 'refresh') {
      void load()
      return
    }
    if (action.kind === 'parse') {
      void parse(asset)
      return
    }
    if (action.kind === 'upload') {
      uploadInput.current?.click()
      return
    }
    if (action.kind === 'confirm_rights') {
      setRightsAsset(asset)
      setRightsScope(asset.rightsScope ?? 'commercial_authorized')
      setAssetDialogError('')
      return
    }
    if (action.kind === 'confirm_facts' || action.kind === 'manual_review') {
      setFactsAsset(asset)
      setFactsJson(
        JSON.stringify(asset.extractedFacts ?? { 用途: '待核对' }, null, 2),
      )
      setFactsReason('商家已核对原始资料')
      setAssetDialogError('')
    }
  }
  const saveVisualRules = async () => {
    if (!baseUrl || !brand) {
      setBrandMessage('请先确认品牌名称，再配置视觉强规则。')
      return
    }
    const primary = splitValues(visualPrimary)
    const secondary = splitValues(visualSecondary)
    const forbidden = splitValues(visualForbidden)
    const fontFamilies = splitValues(visualFonts)
    const styles = splitValues(visualStyles)
    const people = splitValues(restrictedPeople)
    const spokespersons = splitValues(restrictedSpokespersons)
    const intellectualProperties = splitValues(restrictedIps)
    const prohibitedContent = splitValues(restrictedContent)
    const visualRules: BrandVisualRules = {
      ...(visualLogoIds.length
        ? {
            logo: {
              assetIds: visualLogoIds,
              allowRecolor: logoRecolor,
              allowDistortion: logoDistortion,
              allowRedraw: logoRedraw,
            },
          }
        : {}),
      ...(primary.length || secondary.length || forbidden.length
        ? { colors: { primary, secondary, forbidden } }
        : {}),
      ...(fontFamilies.length
        ? {
            fonts: fontFamilies.map((family) => ({
              family,
              licenseStatus: visualFontLicense,
            })),
          }
        : {}),
      ...(styles.length ? { styleKeywords: styles } : {}),
      ...(people.length ||
      spokespersons.length ||
      intellectualProperties.length ||
      prohibitedContent.length
        ? {
            restrictedSubjects: {
              people,
              spokespersons,
              intellectualProperties,
              prohibitedContent,
            },
          }
        : {}),
    }
    setBrandAction('正在校验视觉强规则…')
    setBrandMessage('')
    try {
      const saved = await saveBrandProfile(baseUrl, {
        name: brand.name,
        visual_rules: visualRules,
        source: 'merchant_studio:visual-rules',
        conflict_resolutions: { visualRules: 'candidate' },
      })
      setBrand(saved)
      setBrandMessage(
        `品牌视觉强规则已保存到 r${saved.revision}；之后所有内容、主图和创意生成都会先执行阻断检查。`,
      )
    } catch (cause) {
      setBrandMessage(describeApiError(cause))
    } finally {
      setBrandAction('')
    }
  }
  return (
    <section
      className="panel asset-library"
      id="merchant-assets"
      aria-label="知识、图片与素材"
      tabIndex={-1}
    >
      <div className="panel-heading">
        <div>
          <span className="section-kicker">ASSET LIBRARY</span>
          <h3>素材库</h3>
          <p className="panel-subtitle">
            先确认素材安全与使用权益，再用于商品详情、主图和营销内容。
          </p>
        </div>
      {storageQuota && (
        <div className={`storage-quota-banner ${storageQuota.status}`} role={storageQuota.status === 'over_limit' ? 'alert' : 'status'}>
          <strong>工作区容量</strong>
          <span>{Math.round(storageQuota.usedBytes / 1024 / 1024)} MB 已用 / {Math.round(storageQuota.limitBytes / 1024 / 1024)} MB</span>
          <span>{storageQuota.status === 'over_limit' ? '已超额，暂不能新增素材' : storageQuota.status === 'near_limit' ? '接近上限，建议清理历史版本' : `${Math.round(storageQuota.availableBytes / 1024 / 1024)} MB 可用`}</span>
        </div>
      )}
      <div className="asset-heading-actions">
          <input
            ref={uploadInput}
            data-testid="asset-upload-input"
            className="sr-only"
            type="file"
            multiple
            accept=".jpg,.jpeg,.png,.webp,.gif,.svg,.pdf,.docx,.xlsx,.json,.txt,.md,.csv,.ai,.eps,image/jpeg,image/png,image/webp,image/gif,image/svg+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,text/plain,text/markdown,text/csv,application/postscript"
            onChange={(event) => void uploadFiles(event.target.files)}
          />
          <button
            className="secondary"
            onClick={() => uploadInput.current?.click()}
            disabled={!baseUrl || Boolean(uploadAction)}
          >
            <Upload size={14} />
            {uploadAction || '上传素材'}
          </button>
          <button
            className="secondary"
            onClick={load}
            disabled={!baseUrl || loading || Boolean(assetAction)}
          >
            <RefreshCw size={14} className={loading ? 'spin' : undefined} />
            刷新状态
          </button>
          <StatusChip tone={brand ? 'green' : 'neutral'}>
            {brand ? `品牌档案 r${brand.revision}` : '品牌未建档'}
          </StatusChip>
          <StatusChip tone={assets?.length ? 'green' : 'neutral'}>
            {assets?.length ?? 0} 个素材
          </StatusChip>
          <button
            data-testid="visual-rules-toggle"
            className="secondary"
            onClick={() => setVisualPanelOpen((current) => !current)}
            disabled={!brand}
          >
            <ShieldCheck size={14} />
            {visualPanelOpen ? '收起视觉规则' : '配置视觉强规则'}
          </button>
          <button
            className="secondary"
            onClick={extractBrand}
            disabled={
              !baseUrl ||
              Boolean(brandAction) ||
              !assets?.some((asset) => asset.parseStatus === 'succeeded')
            }
          >
            <Sparkles size={14} />
            {brandAction || '从素材提取品牌档案'}
          </button>
        </div>
      </div>
      <div className="asset-entry-tabs" role="tablist" aria-label="素材类型">
        <button
          id="asset-knowledge-tab"
          role="tab"
          aria-selected={assetEntry === 'knowledge'}
          aria-controls="asset-entry-panel"
          tabIndex={assetEntry === 'knowledge' ? 0 : -1}
          className={assetEntry === 'knowledge' ? 'active' : ''}
          onKeyDown={(event) =>
            handleTabKeyDown(
              event,
              ['knowledge', 'images', 'assets'] as const,
              assetEntry,
              setAssetEntry,
            )
          }
          onClick={() => setAssetEntry('knowledge')}
        >
          <BookOpen size={15} aria-hidden="true" />
          知识库
        </button>
        <button
          id="asset-images-tab"
          role="tab"
          aria-selected={assetEntry === 'images'}
          aria-controls="asset-entry-panel"
          tabIndex={assetEntry === 'images' ? 0 : -1}
          className={assetEntry === 'images' ? 'active' : ''}
          onKeyDown={(event) =>
            handleTabKeyDown(
              event,
              ['knowledge', 'images', 'assets'] as const,
              assetEntry,
              setAssetEntry,
            )
          }
          onClick={() => setAssetEntry('images')}
        >
          <ImageIcon size={15} aria-hidden="true" />
          图片
        </button>
        <button
          id="asset-assets-tab"
          role="tab"
          aria-selected={assetEntry === 'assets'}
          aria-controls="asset-entry-panel"
          tabIndex={assetEntry === 'assets' ? 0 : -1}
          className={assetEntry === 'assets' ? 'active' : ''}
          onKeyDown={(event) =>
            handleTabKeyDown(
              event,
              ['knowledge', 'images', 'assets'] as const,
              assetEntry,
              setAssetEntry,
            )
          }
          onClick={() => setAssetEntry('assets')}
        >
          <FolderOpen size={15} aria-hidden="true" />
          全部素材
        </button>
        <span role="status" aria-live="polite">
          {assetEntry === 'assets'
            ? `全部 ${assets?.length ?? 0} 项`
            : `${assetEntry === 'images' ? '图片' : '知识文档'} ${visibleAssets.length} 项`}
        </span>
      </div>
      <div
        id="asset-entry-panel"
        role="tabpanel"
        aria-labelledby={`asset-${assetEntry}-tab`}
        tabIndex={0}
      >
        <div data-testid="asset-untrusted-boundary" className="info-notice">
          <ShieldCheck size={15} />
          上传文件内容始终按不可信数据读取：不会执行其中指令、改变系统规则或自动调用工具；提取结果需由商家确认。
        </div>
        {brandMessage && (
          <div className="info-notice" role="status">
            <CircleHelp size={15} />
            {brandMessage}
          </div>
        )}
        {brandLoadError && (
          <ErrorNotice
            message={`品牌档案读取失败：${brandLoadError}。素材列表仍可使用。`}
            onRetry={loadBrand}
            compact
          />
        )}
        {storageLoadError && (
          <ErrorNotice
            message={`存储健康读取失败：${storageLoadError}。已停止素材正文读取，但保留元数据操作。`}
            onRetry={loadStorageHealth}
            compact
          />
        )}
        {visualPanelOpen && (
          <section className="visual-rules-panel" aria-label="品牌视觉强规则">
            <div className="brand-candidate-head">
              <div>
                <span className="section-kicker">HARD CONSTRAINTS</span>
                <h4>Logo、品牌色与字体强规则</h4>
                <p>
                  这些不是参考建议：任一素材或字体授权不满足时，内容、主图和创意生成都会被阻止。
                </p>
              </div>
              <button
                data-testid="visual-rules-save"
                className="primary"
                onClick={saveVisualRules}
                disabled={Boolean(brandAction)}
              >
                {brandAction || '校验并保存强规则'}
              </button>
            </div>
            <div className="visual-rules-grid">
              <fieldset>
                <legend>Logo 素材</legend>
                <div className="visual-asset-options">
                  {assets
                    ?.filter((asset) => asset.mimeType.startsWith('image/'))
                    .map((asset) => (
                      <label key={asset.id}>
                        <input
                          type="checkbox"
                          checked={visualLogoIds.includes(asset.id)}
                          onChange={() =>
                            setVisualLogoIds((current) =>
                              current.includes(asset.id)
                                ? current.filter((id) => id !== asset.id)
                                : [...current, asset.id],
                            )
                          }
                        />
                        <span>
                          {asset.name}
                          <small>{statusLabel(asset)}</small>
                        </span>
                      </label>
                    ))}
                </div>
                <div className="visual-logo-guards">
                  <label>
                    <input
                      type="checkbox"
                      checked={logoRecolor}
                      onChange={(event) => setLogoRecolor(event.target.checked)}
                    />
                    允许改色
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={logoDistortion}
                      onChange={(event) =>
                        setLogoDistortion(event.target.checked)
                      }
                    />
                    允许变形
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={logoRedraw}
                      onChange={(event) => setLogoRedraw(event.target.checked)}
                    />
                    允许重绘
                  </label>
                </div>
                <small>
                  默认全部禁止。开启任一项时，Logo 素材还必须明确允许 AI 修改。
                </small>
              </fieldset>
              <fieldset>
                <legend>品牌色（#RRGGBB，逗号分隔）</legend>
                <label>
                  主色
                  <input
                    data-testid="visual-primary"
                    value={visualPrimary}
                    onChange={(event) => setVisualPrimary(event.target.value)}
                    placeholder="#123456, #FFFFFF"
                  />
                </label>
                <label>
                  辅助色
                  <input
                    data-testid="visual-secondary"
                    value={visualSecondary}
                    onChange={(event) => setVisualSecondary(event.target.value)}
                    placeholder="#E5E7EB"
                  />
                </label>
                <label>
                  禁用色
                  <input
                    data-testid="visual-forbidden"
                    value={visualForbidden}
                    onChange={(event) => setVisualForbidden(event.target.value)}
                    placeholder="#FF0000"
                  />
                </label>
              </fieldset>
              <fieldset>
                <legend>字体与风格</legend>
                <label>
                  字体名称
                  <input
                    data-testid="visual-fonts"
                    value={visualFonts}
                    onChange={(event) => setVisualFonts(event.target.value)}
                    placeholder="思源黑体, HarmonyOS Sans"
                  />
                </label>
                <label>
                  字体授权
                  <select
                    data-testid="visual-font-license"
                    value={visualFontLicense}
                    onChange={(event) =>
                      setVisualFontLicense(
                        event.target.value as typeof visualFontLicense,
                      )
                    }
                  >
                    <option value="approved">已批准</option>
                    <option value="restricted">受限</option>
                    <option value="unknown">待确认</option>
                  </select>
                </label>
                <label>
                  风格关键词
                  <input
                    data-testid="visual-styles"
                    value={visualStyles}
                    onChange={(event) => setVisualStyles(event.target.value)}
                    placeholder="克制, 轻户外, 高留白"
                  />
                </label>
                <small
                  className={
                    visualFontLicense === 'approved'
                      ? 'visual-ready'
                      : 'visual-blocked'
                  }
                >
                  {visualFontLicense === 'approved'
                    ? '字体规则可进入生成前检查'
                    : '当前字体授权会阻止生成'}
                </small>
              </fieldset>
            </div>
          </section>
        )}
        {extraction && (
          <section className="brand-candidate-panel" aria-label="品牌候选字段">
            <div className="brand-candidate-head">
              <div>
                <span className="section-kicker">REVIEW BEFORE SAVE</span>
                <h4>逐字段确认品牌档案</h4>
                <p>
                  自动提取不会直接写入。置信度仅代表解析把握，不代表内容正确。
                </p>
              </div>
              <button
                className="primary"
                onClick={confirmBrand}
                disabled={!selectedBrandFields.length || Boolean(brandAction)}
              >
                {brandAction ||
                  `保存已确认字段（${selectedBrandFields.length}）`}
              </button>
            </div>
            <div className="brand-candidate-grid">
              {Object.values(extraction.fields)
                .filter((field): field is NonNullable<typeof field> =>
                  Boolean(field),
                )
                .map((field) => (
                  <article
                    className={`brand-candidate ${field.status}`}
                    key={field.key}
                  >
                    <div className="brand-candidate-title">
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedBrandFields.includes(field.key)}
                          onChange={() => toggleBrandField(field.key)}
                        />
                        <b>{field.label}</b>
                      </label>
                      <StatusChip
                        tone={
                          field.status === 'conflict'
                            ? 'amber'
                            : field.confidence >= 0.85
                              ? 'green'
                              : 'blue'
                        }
                      >
                        {Math.round(field.confidence * 100)}% ·{' '}
                        {field.status === 'conflict' ? '存在冲突' : '待确认'}
                      </StatusChip>
                    </div>
                    {field.alternatives.map((alternative, index) => (
                      <label
                        className="brand-alternative"
                        key={`${field.key}-${index}`}
                      >
                        <input
                          type="radio"
                          name={`brand-${field.key}`}
                          checked={
                            (selectedAlternatives[field.key] ?? 0) === index
                          }
                          onChange={() =>
                            setSelectedAlternatives((current) => ({
                              ...current,
                              [field.key]: index,
                            }))
                          }
                        />
                        <span>
                          <b>{displayBrandValue(alternative.value)}</b>
                          <small>
                            来自 {alternative.sourceAssetIds.length} 份素材 ·
                            置信度 {Math.round(alternative.confidence * 100)}%
                          </small>
                        </span>
                      </label>
                    ))}
                    <small className="brand-source">
                      依据：
                      {[
                        ...new Set(
                          field.sources.map(
                            (source) =>
                              `${source.assetName} · ${source.reference}`,
                          ),
                        ),
                      ].join('；')}
                    </small>
                  </article>
                ))}
            </div>
            {extraction.ignoredAssets.length > 0 && (
              <small className="brand-ignored">
                另有 {extraction.ignoredAssets.length}{' '}
                份素材未读取，未参与本次提取。
              </small>
            )}
          </section>
        )}
        {visualPanelOpen && (
          <section
            className="visual-rules-panel restricted-subjects-panel"
            aria-label="禁用内容与主体强规则"
          >
            <div className="brand-candidate-head">
              <div>
                <span className="section-kicker">PROHIBITED SUBJECTS</span>
                <h4>禁用内容、人物、代言人与 IP</h4>
                <p>
                  生成提示和确定性文案审核都会使用这些强规则；图片中的人物/IP
                  像素识别仍需外部视觉服务复核。
                </p>
              </div>
            </div>
            <div className="visual-rules-grid">
              <fieldset>
                <legend>禁用人物与代言人</legend>
                <label>
                  人物
                  <input
                    data-testid="restricted-people"
                    value={restrictedPeople}
                    onChange={(event) =>
                      setRestrictedPeople(event.target.value)
                    }
                    placeholder="人物姓名，逗号分隔"
                  />
                </label>
                <label>
                  代言人
                  <input
                    data-testid="restricted-spokespersons"
                    value={restrictedSpokespersons}
                    onChange={(event) =>
                      setRestrictedSpokespersons(event.target.value)
                    }
                    placeholder="代言人姓名，逗号分隔"
                  />
                </label>
              </fieldset>
              <fieldset>
                <legend>禁用 IP 与内容</legend>
                <label>
                  IP / 角色
                  <input
                    data-testid="restricted-ips"
                    value={restrictedIps}
                    onChange={(event) => setRestrictedIps(event.target.value)}
                    placeholder="IP、角色或作品名，逗号分隔"
                  />
                </label>
                <label>
                  内容
                  <input
                    data-testid="restricted-content"
                    value={restrictedContent}
                    onChange={(event) =>
                      setRestrictedContent(event.target.value)
                    }
                    placeholder="禁用场景、主题或表现，逗号分隔"
                  />
                </label>
                <small>填写后请点击上方“校验并保存强规则”。</small>
              </fieldset>
            </div>
          </section>
        )}
        {!baseUrl && (
          <div className="info-notice">
            <CircleHelp size={15} />
            连接 API 后读取真实素材；离线模式不会伪造素材权益。
          </div>
        )}
        {loading && <LoadingState label="正在读取素材库…" />}
        {error && <ErrorNotice message={error} onRetry={load} compact />}
        {!loading && !error && baseUrl && !assets?.length && (
          <div className="asset-empty">
            <FileText size={24} />
            <b>素材库还没有内容</b>
            <span>请先上传商品原图、品牌资料或权益证明，再开始生成内容。</span>
          </div>
        )}
        {!loading && !error && !!assets?.length && !visibleAssets.length && (
          <div className="asset-empty">
            <FileText size={24} />
            <b>当前分类暂无素材</b>
            <span>切换到“全部素材”，或上传符合当前类型的文件。</span>
          </div>
        )}
        {!loading && !error && !!visibleAssets.length && (
          <div className="asset-grid">
            {visibleAssets.map((asset) => (
              <article
                className={`asset-card ${asset.preference?.verdict ?? ''}`}
                key={asset.id}
                data-asset-name={asset.name}
              >
                <div
                  className="asset-preview"
                  title={
                    assetStorageReady
                      ? undefined
                      : '对象存储未配置，暂不读取素材正文'
                  }
                >
                  {assetPreviews[asset.id] ? (
                    <img src={assetPreviews[asset.id]} alt={asset.name} />
                  ) : (
                    <FileText size={28} />
                  )}
                </div>
                <div className="asset-card-body">
                  <div className="asset-title-row">
                    <b title={asset.name}>{asset.name}</b>
                    {asset.preference && (
                      <StatusChip
                        tone={
                          asset.preference.verdict === 'excellent'
                            ? 'green'
                            : 'amber'
                        }
                      >
                        {asset.preference.verdict === 'excellent'
                          ? '优秀参考'
                          : '不喜欢'}
                      </StatusChip>
                    )}
                  </div>
                  <span>
                    {asset.mimeType} ·{' '}
                    {Math.max(1, Math.round(asset.sizeBytes / 1024))} KB
                  </span>
                  <div className="asset-status">
                    <StatusChip tone={statusTone(asset)}>
                      {statusLabel(asset)}
                    </StatusChip>
                    <span>
                      {asset.parseStatus === 'succeeded'
                        ? '已读取内容'
                        : asset.parseStatus === 'failed'
                          ? '读取失败'
                          : '待读取'}
                    </span>
                  </div>
                  {asset.references?.length > 1 && (
                    <small
                      data-testid={`asset-reference-count-${asset.id}`}
                      className="asset-preference-reason"
                    >
                      同一文件已有 {asset.references.length} 个上传引用：
                      {asset.references
                        .map((reference) => reference.name)
                        .join('、')}
                    </small>
                  )}
                  {asset.preference && (
                    <small className="asset-preference-reason">
                      原因：{asset.preference.reasons.join('；')}
                    </small>
                  )}
                  {asset.parseError && (
                    <small className="asset-error">{asset.parseError}</small>
                  )}
                  {(() => {
                    const primaryAction = resolveAssetPrimaryAction(asset, {
                      configured: Boolean(baseUrl),
                      busy: Boolean(assetAction),
                    })
                    return (
                      <button
                        data-testid={`asset-primary-action-${asset.id}`}
                        className="primary asset-primary-action"
                        aria-label={`${primaryAction.label}：${asset.name}`}
                        onClick={() => runPrimaryAssetAction(asset)}
                        disabled={primaryAction.disabled}
                      >
                        {assetAction && primaryAction.kind !== 'refresh'
                          ? '处理中…'
                          : primaryAction.label}
                      </button>
                    )
                  })()}
                  <div className="asset-card-actions">
                    <button
                      className="text-button"
                      onClick={() => void openAsset(asset)}
                      disabled={!baseUrl || !assetStorageReady}
                    >
                      {assetStorageReady ? '打开并阅读' : '存储未配置'}
                    </button>
                    <button
                      data-testid={`asset-product-usage-open-${asset.id}`}
                      className="text-button"
                      onClick={() => setUsageAsset(asset)}
                      disabled={!baseUrl}
                    >
                      查看使用商品
                    </button>
                    <button
                      data-testid={`asset-preference-open-${asset.id}`}
                      className="text-button"
                      onClick={() => openPreferenceEditor(asset)}
                    >
                      评价素材
                    </button>
                  </div>
                  <div className="asset-card-actions">
                    <button
                      className="text-button"
                      onClick={() => void parse(asset)}
                      disabled={
                        !baseUrl ||
                        asset.scanStatus !== 'clean' ||
                        asset.parseStatus === 'succeeded' ||
                        Boolean(assetAction)
                      }
                    >
                      {assetAction === `parse-${asset.id}`
                        ? '解析中…'
                        : asset.parseStatus === 'succeeded'
                          ? '已完成解析'
                          : asset.scanStatus === 'clean'
                            ? '解析素材'
                            : '等待扫描'}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setRightsAsset(asset)
                        setRightsScope(
                          asset.rightsScope ?? 'commercial_authorized',
                        )
                        setAssetDialogError('')
                      }}
                      disabled={
                        !baseUrl ||
                        asset.scanStatus !== 'clean' ||
                        asset.rightsStatus === 'approved' ||
                        Boolean(assetAction)
                      }
                    >
                      {assetAction === `rights-${asset.id}`
                        ? '保存中…'
                        : asset.rightsStatus === 'approved'
                          ? '权益已确认'
                          : asset.scanStatus === 'clean'
                            ? '确认权益'
                            : '等待扫描'}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setFactsAsset(asset)
                        setFactsJson(
                          JSON.stringify(
                            asset.extractedFacts ?? { 用途: '待核对' },
                            null,
                            2,
                          ),
                        )
                        setFactsReason('商家已核对原始资料')
                        setAssetDialogError('')
                      }}
                      disabled={
                        !baseUrl ||
                        asset.scanStatus !== 'clean' ||
                        Boolean(assetAction)
                      }
                    >
                      {assetAction === `facts-${asset.id}`
                        ? '保存中…'
                        : asset.factsConfirmedBy
                          ? '事实已确认'
                          : asset.scanStatus === 'clean'
                            ? '确认事实'
                            : '等待扫描'}
                    </button>
                  </div>
                  {preferenceAssetId === asset.id && (
                    <div
                      className="asset-preference-editor"
                      aria-label={`评价素材 ${asset.name}`}
                    >
                      <label>
                        评价
                        <select
                          data-testid="asset-preference-verdict"
                          value={preferenceVerdict}
                          onChange={(event) =>
                            setPreferenceVerdict(
                              event.target.value as 'excellent' | 'disliked',
                            )
                          }
                        >
                          <option value="excellent">优秀，后续作为参考</option>
                          <option value="disliked">不喜欢，后续排除</option>
                        </select>
                      </label>
                      <label>
                        原因
                        <input
                          data-testid="asset-preference-reasons"
                          value={preferenceReasons}
                          onChange={(event) =>
                            setPreferenceReasons(event.target.value)
                          }
                          placeholder="如：主体清晰、留白合适"
                        />
                      </label>
                      <label>
                        补充说明
                        <input
                          value={preferenceNote}
                          onChange={(event) =>
                            setPreferenceNote(event.target.value)
                          }
                          placeholder="可选，最多 500 字"
                        />
                      </label>
                      <div>
                        <button
                          data-testid="asset-preference-save"
                          className="primary"
                          onClick={() => savePreference(asset)}
                          disabled={Boolean(preferenceAction)}
                        >
                          {preferenceAction || '保存评价'}
                        </button>
                        {asset.preference && (
                          <button
                            className="secondary"
                            onClick={() => clearPreference(asset)}
                            disabled={Boolean(preferenceAction)}
                          >
                            清除评价
                          </button>
                        )}
                        <button
                          className="secondary"
                          onClick={() => setPreferenceAssetId('')}
                          disabled={Boolean(preferenceAction)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {rightsAsset && (
        <DialogFrame
          testId="asset-rights-dialog"
          kicker="RIGHTS CONFIRMATION"
          title={`确认“${rightsAsset.name}”的权益`}
          onClose={() => setRightsAsset(null)}
          busy={assetAction === `rights-${rightsAsset.id}`}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setRightsAsset(null)}
                disabled={Boolean(assetAction)}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => void confirmRights()}
                disabled={Boolean(assetAction)}
              >
                确认权益
              </button>
            </>
          }
        >
          <div className="dialog-form">
            <label htmlFor="asset-rights-scope">
              权益范围
              <select
                id="asset-rights-scope"
                data-dialog-initial-focus
                value={rightsScope}
                onChange={(event) => setRightsScope(event.target.value)}
              >
                <option value="owned">自有素材</option>
                <option value="commercial_authorized">已获商用授权</option>
                <option value="limited_use">受限使用</option>
                <option value="internal_only">仅内部使用</option>
              </select>
            </label>
            <small>本次不授予 AI 修改许可；改图仍需单独确认。</small>
            {assetDialogError && (
              <ErrorNotice message={assetDialogError} compact />
            )}
          </div>
        </DialogFrame>
      )}
      {factsAsset && (
        <DialogFrame
          testId="asset-facts-dialog"
          kicker="FACT VERIFICATION"
          title={`确认“${factsAsset.name}”的事实`}
          onClose={() => setFactsAsset(null)}
          busy={assetAction === `facts-${factsAsset.id}`}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setFactsAsset(null)}
                disabled={Boolean(assetAction)}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => void confirmFacts()}
                disabled={Boolean(assetAction)}
              >
                保存已核对事实
              </button>
            </>
          }
        >
          <div className="dialog-form">
            <FactsEditor
              value={factsJson}
              onChange={(value) => {
                setFactsJson(value)
                setAssetDialogError('')
              }}
            />
            <label htmlFor="asset-facts-reason">
              核对来源或原因
              <input
                id="asset-facts-reason"
                data-dialog-initial-focus
                value={factsReason}
                onChange={(event) => {
                  setFactsReason(event.target.value)
                  setAssetDialogError('')
                }}
                maxLength={500}
              />
            </label>
            {assetDialogError && (
              <ErrorNotice message={assetDialogError} compact />
            )}
          </div>
        </DialogFrame>
      )}
      {usageAsset && baseUrl && (
        <AssetProductUsageDialog
          baseUrl={baseUrl}
          asset={usageAsset}
          onClose={() => setUsageAsset(null)}
        />
      )}
    </section>
  )
}

function ProductAssetRelationDialog({
  baseUrl,
  productId,
  onClose,
  onContinue,
}: {
  baseUrl: string
  productId: string
  onClose: () => void
  onContinue: (product: ApiProduct) => void
}) {
  const [product, setProduct] = useState<ApiProduct | null>(null)
  const [assets, setAssets] = useState<AssetMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    Promise.all([
      fetchProduct(baseUrl, productId),
      fetchProductAssetBindings(baseUrl, productId),
      fetchAssets(baseUrl),
    ])
      .then(([nextProduct, bindings, nextAssets]) => {
        if (!active) return
        setProduct({
          ...nextProduct,
          sourceAssetIds: bindings.items
            .filter((item) => item.status === 'active')
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((item) => item.assetId),
        })
        setAssets(nextAssets)
      })
      .catch((cause) => {
        if (active) setError(describeApiError(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [baseUrl, productId])

  const relation = product
    ? resolveProductAssetRelation(product, assets)
    : { boundIds: [], matchedAssets: [], missingAssetIds: [] }
  const reload = () => {
    setLoading(true)
    setError('')
    void Promise.all([
      fetchProduct(baseUrl, productId),
      fetchProductAssetBindings(baseUrl, productId),
      fetchAssets(baseUrl),
    ])
      .then(([nextProduct, bindings, nextAssets]) => {
        setProduct({
          ...nextProduct,
          sourceAssetIds: bindings.items
            .filter((item) => item.status === 'active')
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((item) => item.assetId),
        })
        setAssets(nextAssets)
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setLoading(false))
  }
  const mutateBinding = (assetId: string, mode: 'bind' | 'unbind') => {
    if (!product?.brandId || !product.version) {
      setError('商品缺少品牌或版本信息，无法安全写入关系')
      return
    }
    setSaving(true)
    void changeProductAssetBinding(
      baseUrl,
      product.id,
      {
        assetId,
        brandId: product.brandId,
        expectedVersion: product.version,
        reason:
          mode === 'bind'
            ? 'Merchant Studio 绑定商品素材'
            : 'Merchant Studio 解除商品素材绑定',
      },
      mode,
    )
      .then(reload)
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setSaving(false))
  }
  return (
    <DialogFrame
      testId="product-asset-relation-dialog"
      kicker="PRODUCT · ASSET RELATION"
      title="商品与素材关系"
      onClose={onClose}
      actions={
        <>
          <button
            className="secondary"
            onClick={() => product && onContinue(product)}
            disabled={!product || loading || Boolean(error)}
          >
            使用已绑定素材继续生成
          </button>
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      {/* relation actions */}
      {loading && <LoadingState label="正在读取商品与素材关系…" />}
      {error && (
        <ErrorNotice
          message={`关系读取失败：${error}`}
          onRetry={() => {
            setError('')
            setLoading(true)
            void Promise.all([
              fetchProduct(baseUrl, productId),
              fetchProductAssetBindings(baseUrl, productId),
              fetchAssets(baseUrl),
            ])
              .then(([nextProduct, bindings, nextAssets]) => {
                setProduct({
                  ...nextProduct,
                  sourceAssetIds: bindings.items
                    .filter((item) => item.status === 'active')
                    .sort((left, right) => left.ordinal - right.ordinal)
                    .map((item) => item.assetId),
                })
                setAssets(nextAssets)
              })
              .catch((cause) => setError(describeApiError(cause)))
              .finally(() => setLoading(false))
          }}
        />
      )}
      {!loading && !error && product && (
        <div className="product-asset-relation">
          <div className="relation-context">
            <div className="product-thumb">
              <ShoppingBag size={20} />
            </div>
            <div>
              <b>{product.title}</b>
              <span>
                {platformNames[product.platform]} ·{' '}
                {product.storeName ?? '店铺身份待确认'}
              </span>
            </div>
          </div>
          <div className="relation-summary">
            <StatusChip tone={relation.boundIds.length ? 'green' : 'amber'}>
              {relation.boundIds.length
                ? `已绑定 ${relation.boundIds.length} 份素材`
                : '未绑定素材'}
            </StatusChip>
            <span>
              仅展示商品 API
              返回的已绑定素材；本页不会新增、修改或推断绑定关系。
            </span>
          </div>
          {relation.boundIds.length === 0 && (
            <div className="empty-inline">
              <FolderOpen size={16} />
              素材库中尚未记录该商品的默认素材。请在商品导入/编辑入口完成服务端绑定后再刷新。
            </div>
          )}
          {relation.boundIds.length > 0 && (
            <div className="relation-list" aria-label="商品已绑定素材列表">
              {relation.boundIds.map((assetId) => {
                const asset = assets.find((item) => item.id === assetId)
                return (
                  <div className="relation-row" key={assetId}>
                    <div>
                      <b>{asset?.name ?? '素材记录待恢复'}</b>
                      <span>
                        {asset
                          ? `${asset.mimeType} · ${asset.sizeBytes.toLocaleString()} B`
                          : '当前列表未返回该素材的详细信息'}
                      </span>
                    </div>
                    <div className="relation-row-actions">
                      <StatusChip
                        tone={
                          asset
                            ? asset.rightsStatus === 'approved' &&
                              asset.scanStatus === 'clean'
                              ? 'green'
                              : 'amber'
                            : 'amber'
                        }
                      >
                        {asset
                          ? asset.rightsStatus === 'approved' &&
                            asset.scanStatus === 'clean'
                            ? '可作为生成来源'
                            : '需完成扫描/权益'
                          : '素材未找到'}
                      </StatusChip>
                      <button
                        className="text-button"
                        disabled={saving}
                        onClick={() => mutateBinding(assetId, 'unbind')}
                      >
                        解除绑定
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div className="relation-bind-row">
            <select
              aria-label="选择素材"
              value={selectedAssetId}
              onChange={(event) => setSelectedAssetId(event.target.value)}
            >
              <option value="">选择素材后绑定</option>
              {assets
                .filter((asset) => !relation.boundIds.includes(asset.id))
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
            </select>
            <button
              className="secondary"
              disabled={!selectedAssetId || saving}
              onClick={() => {
                mutateBinding(selectedAssetId, 'bind')
                setSelectedAssetId('')
              }}
            >
              绑定素材
            </button>
          </div>
          <div className="relation-note">
            <Link2 size={15} />
            <span>
              绑定和解除绑定都会携带商品版本、品牌、原因并写入审计；失败时不会显示成功。生成前仍需检查扫描、权益和平台适用范围。
            </span>
          </div>
        </div>
      )}
    </DialogFrame>
  )
}

function Products({
  baseUrl,
  initialQuery = '',
  initialEntry = 'products',
  onSelectTarget,
  onOpenTasks,
  onConnectStores,
}: {
  baseUrl?: string
  initialQuery?: string
  initialEntry?: MerchantEntryPoint
  onSelectTarget: (target: Target) => void
  onOpenTasks: () => void
  onConnectStores: () => void
}) {
  const accountsRequestId = useRef(0)
  const productsRequestId = useRef(0)
  const [query, setQuery] = useState(initialQuery)
  const [remoteProducts, setRemoteProducts] = useState<ApiProduct[] | null>(
    null,
  )
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(
    baseUrl ? null : [],
  )
  const [accountsLoading, setAccountsLoading] = useState(Boolean(baseUrl))
  const [accountsError, setAccountsError] = useState('')
  const [selectedTargets, setSelectedTargets] = useState<Target[]>([])
  const [productFilter, setProductFilter] = useState<'all' | 'needsReview'>(
    'all',
  )
  const [platformFilter, setPlatformFilter] = useState<PlatformId | 'all'>(
    'all',
  )
  const [accountFilter, setAccountFilter] = useState('')
  const [productPage, setProductPage] = useState(0)
  const [productTotal, setProductTotal] = useState(0)
  const [groupCreating, setGroupCreating] = useState(false)
  const [groupMessage, setGroupMessage] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [importDraft, setImportDraft] = useState({
    title: '',
    platform: 'taobao' as PlatformId,
    category: '',
    price: '0',
    stock: '0',
  })
  const [importAssets, setImportAssets] = useState<AssetMetadata[]>([])
  const [selectedImportAssetIds, setSelectedImportAssetIds] = useState<
    string[]
  >([])
  const [importAssetsLoading, setImportAssetsLoading] = useState(false)
  const [groupConfirmOpen, setGroupConfirmOpen] = useState(false)
  const [imageReviewMessage, setImageReviewMessage] = useState('')
  const [imageGenerationTarget, setImageGenerationTarget] = useState<Target | null>(null)
  const [imageGenerationMode, setImageGenerationMode] = useState<'create' | 'optimize'>('create')
  const [imageGenerationDirection, setImageGenerationDirection] = useState('保留商品本体，生成适合电商首图的干净背景与克制光影')
  const [imageGenerationCount, setImageGenerationCount] = useState('1')
  const [imageGenerationBusy, setImageGenerationBusy] = useState(false)
  const [imageGenerationError, setImageGenerationError] = useState('')
  const [relationProductId, setRelationProductId] = useState('')
  const productListRef = useRef<HTMLElement>(null)
  const loadProducts = (resetSelection = false) => {
    if (!baseUrl) return
    const requestId = ++productsRequestId.current
    setLoading(true)
    setError('')
    if (resetSelection) setSelectedTargets([])
    fetchProductPage(baseUrl, {
      query: query.trim() || undefined,
      ...(platformFilter !== 'all' ? { platform: platformFilter } : {}),
      ...(accountFilter ? { accountId: accountFilter } : {}),
      ...(productFilter === 'needsReview' ? { factsConfirmed: false } : {}),
      limit: 10,
      offset: productPage * 10,
    })
      .then((result) => {
        if (requestId === productsRequestId.current) {
          setRemoteProducts(result.items)
          setProductTotal(result.total)
        }
      })
      .catch((cause: Error) => {
        if (requestId === productsRequestId.current) {
          setRemoteProducts(null)
          setProductTotal(0)
          setError(describeApiError(cause))
        }
      })
      .finally(() => {
        if (requestId === productsRequestId.current) setLoading(false)
      })
  }
  const loadAccounts = () => {
    const requestId = ++accountsRequestId.current
    if (!baseUrl) {
      setAccounts([])
      setAccountsLoading(false)
      setAccountsError('')
      return
    }
    setAccountsLoading(true)
    setAccountsError('')
    setAccounts(null)
    fetchPlatformAccounts(baseUrl)
      .then((result) => {
        if (requestId === accountsRequestId.current) setAccounts(result.items)
      })
      .catch((cause) => {
        if (requestId === accountsRequestId.current) {
          setAccounts(null)
          setAccountsError(
            `店铺发现失败：${describeApiError(cause)}。为避免同步到错误店铺，已停止全部同步。`,
          )
        }
      })
      .finally(() => {
        if (requestId === accountsRequestId.current) setAccountsLoading(false)
      })
  }
  useEffect(() => {
    loadAccounts()
  }, [baseUrl])
  useEffect(() => {
    if (!baseUrl) return
    productsRequestId.current += 1
    const timer = window.setTimeout(
      () => loadProducts(productPage === 0),
      query.trim() ? 250 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      productsRequestId.current += 1
    }
  }, [
    baseUrl,
    query,
    productFilter,
    platformFilter,
    accountFilter,
    productPage,
  ])
  useEffect(() => {
    setQuery(initialQuery)
  }, [initialQuery])
  useEffect(() => {
    const destination =
      initialEntry === 'products'
        ? productListRef.current
        : document.getElementById('merchant-assets')
    window.requestAnimationFrame(() =>
      destination?.focus({ preventScroll: true }),
    )
    destination?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'start',
    })
  }, [initialEntry])
  const rows = remoteProducts
    ? prioritizeProducts(remoteProducts).map((product) => ({
        id: product.id,
        platformId: product.platform,
        accountId: product.accountId,
        storeName: product.storeName,
        title: product.title,
        remoteId: product.remoteId,
        name: product.title,
        sku: `${product.skuCount} SKU`,
        platform: platformLabel[product.platform] ?? product.platform,
        source: productSourceLabel(product.source),
        status: product.factsConfirmed ? '事实已确认' : '待确认',
        factsConfirmed: product.factsConfirmed,
        stock: product.stock,
        issue: product.factsConfirmed ? 0 : 1,
        sourceAssetIds: product.sourceAssetIds ?? [],
        canonicalScope: product.canonical_scope,
      }))
    : baseUrl
      ? []
      : products.map((product, index) => ({
          ...product,
          id: `prod_fixture_${index + 1}`,
          platformId: (Object.entries(platformLabel).find(
            ([, label]) => label === product.platform,
          )?.[0] ?? 'taobao') as PlatformId,
          title: product.name,
          remoteId: undefined,
          accountId: undefined,
          storeName: '离线演示店铺',
          sourceAssetIds: [],
          factsConfirmed: true,
          canonicalScope: undefined,
        }))
  const visible = useMemo(
    () =>
      rows.filter((p) => {
        if (!baseUrl) {
          if (platformFilter !== 'all' && p.platformId !== platformFilter)
            return false
          if (accountFilter && p.accountId !== accountFilter) return false
        }
        if (baseUrl) return true
        if (!(
          p.name.includes(query) ||
          p.platform.includes(query) ||
          p.storeName.includes(query)
        ))
          return false
        if (productFilter === 'needsReview') return p.issue > 0
        return true
      }),
    [accountFilter, baseUrl, platformFilter, productFilter, query, rows],
  )
  const productPageSize = 10
  const effectiveProductTotal = baseUrl ? productTotal : visible.length
  const productPageCount = Math.max(
    1,
    Math.ceil(effectiveProductTotal / productPageSize),
  )
  const pagedVisible = baseUrl
    ? visible
    : visible.slice(
        productPage * productPageSize,
        (productPage + 1) * productPageSize,
      )
  useEffect(() => {
    setProductPage(0)
  }, [accountFilter, platformFilter, query, productFilter])
  const productStats = useMemo(
    () => ({
      total: baseUrl
        ? productFilter === 'all'
          ? productTotal
          : '—'
        : rows.length,
      needsReview: baseUrl
        ? productFilter === 'needsReview'
          ? productTotal
          : '—'
        : rows.filter((product) => product.issue > 0).length,
    }),
    [baseUrl, productFilter, productTotal, rows],
  )
  const productListUnavailable = Boolean(
    baseUrl && !loading && remoteProducts === null,
  )
  const showAssetLibrary = initialEntry !== 'products'
  const syncableAccountCount = (accounts ?? []).filter(
    (account) => account.readEnabled && Boolean(account.accountId),
  ).length
  const sync = async () => {
    if (!baseUrl) return
    const resolution = resolveStoreSyncTargets(accounts)
    if (!resolution.ok) {
      setError(resolution.message)
      return
    }
    setError('')
    setSyncing(true)
    try {
      const results = await Promise.allSettled(
        resolution.targets.map((target) =>
          syncPlatform(baseUrl, target.platform, target.accountId),
        ),
      )
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [
              `${platformNames[resolution.targets[index].platform]} · ${resolution.targets[index].label}：${describeApiError(result.reason)}`,
            ]
          : [],
      )
      try {
        const refreshed = await fetchProductPage(baseUrl, {
          query: query.trim() || undefined,
          ...(productFilter === 'needsReview' ? { factsConfirmed: false } : {}),
          limit: productPageSize,
          offset: productPage * productPageSize,
        })
        setRemoteProducts(refreshed.items)
        setProductTotal(refreshed.total)
      } catch (cause) {
        setRemoteProducts(null)
        setSelectedTargets([])
        failures.push(`商品列表刷新失败：${describeApiError(cause)}`)
      }
      if (failures.length)
        setError(`部分店铺同步失败；未自动改选其他店铺。${failures.join('；')}`)
    } finally {
      setSyncing(false)
    }
  }
  const openImport = () => {
    setImportDraft({
      title: '',
      platform: 'taobao',
      category: '',
      price: '0',
      stock: '0',
    })
    setSelectedImportAssetIds([])
    setImportError('')
    setImportOpen(true)
    if (baseUrl) {
      setImportAssetsLoading(true)
      fetchAssets(baseUrl)
        .then(setImportAssets)
        .catch((cause) =>
          setImportError(`读取素材失败：${describeApiError(cause)}`),
        )
        .finally(() => setImportAssetsLoading(false))
    }
  }
  const importLocalProduct = async () => {
    if (!baseUrl || importing) return
    const title = importDraft.title.trim()
    const category = importDraft.category.trim()
    const price = Number(importDraft.price)
    const stock = Number(importDraft.stock)
    if (!title) {
      setImportError('请输入商品名称。')
      return
    }
    if (!category) {
      setImportError('请输入平台类目；创建商品时不能省略。')
      return
    }
    if (!Number.isFinite(price) || price < 0) {
      setImportError('价格必须是大于或等于 0 的数字。')
      return
    }
    if (!Number.isInteger(stock) || stock < 0) {
      setImportError('库存必须是大于或等于 0 的整数。')
      return
    }
    setImporting(true)
    setImportError('')
    try {
      await importProduct(baseUrl, {
        platform: importDraft.platform,
        title,
        local_product_key: `${importDraft.platform}:${title}`,
        category,
        price,
        stock,
        ...(selectedImportAssetIds.length
          ? { asset_ids: selectedImportAssetIds }
          : {}),
      })
      setImportOpen(false)
      loadProducts()
    } catch (cause) {
      setImportError(describeApiError(cause))
    } finally {
      setImporting(false)
    }
  }
  const toggleTarget = (target: Target) =>
    setSelectedTargets((current) => toggleBatchTarget(current, target))
  const batchReadiness = resolveBatchReadiness(
    Boolean(baseUrl),
    selectedTargets.length,
  )
  const consistencyItems = resolveDataConsistency({
    apiConfigured: Boolean(baseUrl),
    productsLoaded: !loading && !productListUnavailable,
    productCount: visible.length,
    accountsLoaded: !accountsLoading && Boolean(accounts),
    accountsError: Boolean(accountsError),
    selectedCount: selectedTargets.length,
    productsWithIdentity: visible.filter((product) =>
      Boolean(product.accountId && product.storeName),
    ).length,
    productsWithAssets: visible.filter(
      (product) => product.sourceAssetIds.length > 0,
    ).length,
    canonicalStatuses: visible.map((product) => product.canonicalScope?.verification_status).filter((status): status is 'verified' | 'legacy_only' | 'conflict' | 'blocked' => Boolean(status)),
  })
  const createGroup = async () => {
    if (!baseUrl || selectedTargets.length < 2) return
    setGroupCreating(true)
    setError('')
    setGroupMessage('')
    try {
      const result = await createTaskGroup(
        baseUrl,
        selectedTargets.map((item) => ({
          product_id: item.productId,
          platform: item.platform,
          ...(item.accountId ? { account_id: item.accountId } : {}),
        })),
        '多平台同步发布任务',
      )
      setGroupMessage(batchCompletionMessage(result.id, result.tasks.length))
      setSelectedTargets([])
      setGroupConfirmOpen(false)
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setGroupCreating(false)
    }
  }
  const checkImages = async (productId: string) => {
    if (!baseUrl) return
    try {
      const result = await reviewProductImages(baseUrl, productId)
      const blocking = result.findings.filter(
        (finding) => finding.severity === 'error',
      )
      setImageReviewMessage(
        blocking.length
          ? `主图检查阻断：${blocking.map((finding) => finding.message).join('；')}`
          : `主图确定性检查通过。仍需外部验证：${result.externallyUnverified.join('、') || '无'}`,
      )
    } catch (cause) {
      setError(describeApiError(cause))
    }
  }
  const submitImageGeneration = async () => {
    if (!baseUrl || !imageGenerationTarget || imageGenerationBusy) return
    const direction = imageGenerationDirection.trim()
    const count = Number(imageGenerationCount)
    if (!direction) { setImageGenerationError('请填写图片生成方向。'); return }
    if (!Number.isInteger(count) || count < 1 || count > 6) { setImageGenerationError('候选数量必须是 1–6。'); return }
    setImageGenerationBusy(true); setImageGenerationError('')
    try {
      const result = await generateProductImages(baseUrl, { product_id: imageGenerationTarget.productId, platform: imageGenerationTarget.platform, ...(imageGenerationTarget.accountId ? { account_id: imageGenerationTarget.accountId } : {}), direction, mode: imageGenerationMode, count, idempotency_key: `merchant-studio-image-${imageGenerationTarget.productId}-${imageGenerationTarget.platform}-${count}-${direction}` })
      setImageGenerationTarget(null)
      window.location.href = `${window.location.pathname}?image_job=${encodeURIComponent(result.job_id)}`
    } catch (cause) { setImageGenerationError(describeApiError(cause)) }
    finally { setImageGenerationBusy(false) }
  }
  if (showAssetLibrary)
    return (
      <div className="page-stack" data-testid="asset-workspace">
        <AssetLibrary
          baseUrl={baseUrl}
          initialEntry={initialEntry as Exclude<MerchantEntryPoint, 'products'>}
        />
      </div>
    )
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="section-kicker">COMMERCE FACTS</span>
          <h2>一处管理商品事实与来源</h2>
          <p>
            平台原值、本地确认值和来源证据同时保留。AI 不会覆盖你的商品真相。
          </p>
        </div>
        <div className="button-row">
          <button
            className="secondary"
            onClick={openImport}
            disabled={!baseUrl}
          >
            导入待创建商品
          </button>
          <button
            className="secondary"
            onClick={() => setGroupConfirmOpen(true)}
            disabled={!batchReadiness.canCreateGroup || groupCreating}
            aria-describedby="batch-action-help"
            title={batchReadiness.nextStep}
          >
            {groupCreating
              ? '创建任务组中…'
              : `创建独立任务组${selectedTargets.length ? `（${selectedTargets.length}）` : ''}`}
          </button>
          {baseUrl &&
            !accountsLoading &&
            !accountsError &&
            accounts &&
            syncableAccountCount === 0 && (
              <button className="primary" onClick={onConnectStores}>
                先连接店铺
              </button>
            )}
          <button
            className="primary"
            onClick={() => void sync()}
            disabled={
              loading ||
              syncing ||
              accountsLoading ||
              Boolean(accountsError) ||
              !baseUrl ||
              syncableAccountCount === 0
            }
          >
            <RefreshCw
              size={17}
              className={
                loading || syncing || accountsLoading ? 'spin' : undefined
              }
            />
            {syncing
              ? '同步全部店铺…'
              : accountsLoading
                ? '正在发现店铺…'
                : !baseUrl
                  ? '演示数据'
                  : syncableAccountCount === 0
                    ? '等待店铺连接'
                    : '同步全部店铺'}
          </button>
          <small id="batch-action-help" className="action-help">
            {syncableAccountCount === 0 && baseUrl && !accountsLoading
              ? '下一步：先连接一个可读取的店铺，再回来同步商品。'
              : batchReadiness.canCreateGroup
                ? '已满足批量条件：将按商品 + 平台 + 店铺拆成独立子任务。'
                : batchReadiness.nextStep}
          </small>
        </div>
      </section>
      <section className="scope-summary" aria-label="商品与素材当前范围">
        <div>
          <span className="section-kicker">CURRENT SCOPE</span>
          <b>
            {platformFilter === 'all'
              ? '全部平台'
              : platformNames[platformFilter]}
          </b>
          <span>→</span>
          <b>
            {accountFilter
              ? ((accounts ?? []).find(
                  (account) => account.accountId === accountFilter,
                )?.storeName ??
                (accounts ?? []).find(
                  (account) => account.accountId === accountFilter,
                )?.label ??
                '店铺身份待确认')
              : '全部店铺'}
          </b>
        </div>
        <small>
          {selectedTargets.length
            ? `已选择 ${selectedTargets.length} 个商品目标；每个目标会保留自己的平台和店铺。`
            : '先用上方筛选确定平台和店铺，再选择商品。素材库只处理上传、解析和权益确认。'}
        </small>
      </section>
      <CanonicalConsistencyPanel
        items={consistencyItems}
        errorMessage={productListUnavailable ? '商品列表暂不可用，规范商品状态无法确认。' : undefined}
        onRefresh={loadProducts}
        refreshing={loading}
      />
      <section
        className="batch-readiness"
        data-testid="batch-readiness"
        aria-label="批量任务入口说明"
      >
        <div>
          <span className="section-kicker">BATCH WORKFLOW</span>
          <b>批量入口只创建任务组</b>
          <small>
            {batchReadiness.selectionLabel} · {batchReadiness.nextStep}
          </small>
        </div>
        <div className="batch-readiness-steps">
          <span>1 选择商品/平台/店铺</span>
          <span>2 创建独立子任务</span>
          <span>3 逐个生成 → 审核 → 发布</span>
        </div>
      </section>
      {showAssetLibrary && (
        <AssetLibrary
          baseUrl={baseUrl}
          initialEntry={initialEntry as Exclude<MerchantEntryPoint, 'products'>}
        />
      )}
      {!baseUrl && (
        <div className="info-notice" role="status">
          <CircleHelp size={16} />
          当前为离线演示，配置 <code>VITE_API_BASE_URL</code>{' '}
          后可读取真实商品并执行同步。
        </div>
      )}
      {baseUrl &&
        visible.length > 0 &&
        visible.every((product) => product.source === '演示数据') && (
          <div className="info-notice" role="status">
            <CircleHelp size={16} />
            当前商品均来自演示数据，不属于你的店铺，也不会发布到真实平台；请先完成真实店铺授权和同步。
          </div>
        )}
      {accountsError && (
        <ErrorNotice message={accountsError} onRetry={loadAccounts} />
      )}
      {!accountsLoading && !accountsError && accounts && (
        <div className="info-notice" role="status">
          <Store size={16} />
          {syncableAccountCount
            ? `已发现 ${syncableAccountCount} 家可同步店铺；同步会逐店执行，不会默认选择同平台第一家店。`
            : '未发现已授权且可读取的店铺；请先连接店铺，再回来同步商品。'}
        </div>
      )}
      {groupMessage && (
        <div
          data-testid="task-group-created"
          className="info-notice"
          role="status"
        >
          <CheckCircle2 size={16} />
          <span>{groupMessage}</span>
          <button className="text-button" onClick={onOpenTasks}>
            查看营销任务 <ArrowRight size={14} />
          </button>
        </div>
      )}
      {error && <ErrorNotice message={error} onRetry={loadProducts} />}
      <section
        className="panel table-panel"
        id="merchant-products"
        ref={productListRef}
        tabIndex={-1}
        aria-label="商品列表"
      >
        <div className="table-toolbar">
          <label className="inline-search">
            <Search size={16} />
            <span className="sr-only">搜索商品</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索商品或平台"
            />
          </label>
          <label className="sr-only" htmlFor="product-platform-filter">
            按平台筛选
          </label>
          <select
            id="product-platform-filter"
            value={platformFilter}
            onChange={(event) => {
              setPlatformFilter(event.target.value as PlatformId | 'all')
              setAccountFilter('')
            }}
          >
            <option value="all">全部平台</option>
            {Object.entries(platformNames).map(([id, label]) => (
              <option value={id} key={id}>
                {label}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="product-store-filter">
            按店铺筛选
          </label>
          <select
            id="product-store-filter"
            value={accountFilter}
            onChange={(event) => setAccountFilter(event.target.value)}
          >
            <option value="">全部店铺</option>
            {(accounts ?? [])
              .filter(
                (account) =>
                  account.accountId &&
                  (platformFilter === 'all' ||
                    account.platform === platformFilter),
              )
              .map((account) => (
                <option
                  value={account.accountId}
                  key={`${account.platform}:${account.accountId}`}
                >
                  {account.storeName ??
                    account.alias ??
                    account.label ??
                    account.accountId}{' '}
                  · {platformNames[account.platform]}
                </option>
              ))}
          </select>
          <div className="filter-group">
            <button
              className={'filter ' + (productFilter === 'all' ? 'active' : '')}
              onClick={() => setProductFilter('all')}
            >
              全部 {productStats.total}
            </button>
            <button
              className={
                'filter ' + (productFilter === 'needsReview' ? 'active' : '')
              }
              onClick={() => setProductFilter('needsReview')}
            >
              待确认 {productStats.needsReview}
            </button>
          </div>
        </div>
        {selectedTargets.length > 0 && (
          <div
            data-testid="task-group-selection"
            className="task-group-selection"
          >
            <div>
              <b>批量任务目标</b>
              <small>
                同一品可选择多个平台和多个店铺；每个店铺会生成独立子任务。
              </small>
            </div>
            {selectedTargets.map((item) => (
              <span key={batchTargetKey(item)}>
                <StatusChip tone="green">
                  {platformNames[item.platform]}
                </StatusChip>
                {item.title} · {item.storeName}
              </span>
            ))}
          </div>
        )}
        <div className="table-wrap">
          {loading ? (
            <LoadingState label="正在读取商品事实…" />
          ) : productListUnavailable ? (
            <div className="empty-state" data-testid="products-unavailable">
              <AlertCircle size={22} />
              <b>商品列表暂不可用</b>
              <span>当前未展示任何演示商品。请先重试并读取真实商品。</span>
            </div>
          ) : visible.length ? (
            <table>
              <thead>
                <tr>
                  <th>任务组</th>
                  <th>商品</th>
                  <th>平台</th>
                  <th>店铺</th>
                  <th>素材关系</th>
                  <th>事实来源</th>
                  <th>可售库存</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedVisible.map((product) => {
                  const target = {
                    productId: product.id,
                    platform: product.platformId,
                    title: product.title,
                    remoteId: product.remoteId,
                    accountId: product.accountId,
                    storeName: product.storeName,
                  }
                  const identityError = validateTargetStoreIdentity(target)
                  const canonicalStatus = product.canonicalScope?.verification_status
                  const canonicalUnverified = !canonicalProductActionAllowed({ apiConfigured: Boolean(baseUrl), status: canonicalStatus })
                  const canonicalCopy = canonicalStatus
                    ? canonicalStatusCopy[canonicalStatus]
                    : { label: '标准链未取得', detail: '服务端尚未返回规范商品状态', tone: 'amber' }
                  return (
                    <tr
                      key={`${product.id}:${product.platformId}:${product.accountId ?? ''}`}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择${product.name}（${product.storeName}）加入任务组`}
                          checked={selectedTargets.some(
                            (item) =>
                              batchTargetKey(item) === batchTargetKey(target),
                          )}
                          onChange={() => toggleTarget(target)}
                          disabled={
                            !baseUrl ||
                            productListUnavailable ||
                            Boolean(identityError) ||
                            Boolean(canonicalUnverified)
                          }
                        />
                      </td>
                      <td>
                        <div className="product-cell">
                          <div className="product-thumb">
                            <ShoppingBag size={20} />
                          </div>
                          <div>
                            <b>{product.name}</b>
                            <span>{product.sku}</span>
                          </div>
                        </div>
                      </td>
                      <td>{product.platform}</td>
                      <td>
                        <div className="store-identity">
                          <b>{product.storeName}</b>
                          <span>
                            {product.accountId
                              ? '店铺身份已确认'
                              : '店铺身份待确认'}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="relation-cell">
                          <StatusChip
                            tone={
                              product.sourceAssetIds.length ? 'green' : 'amber'
                            }
                          >
                            <Link2 size={12} />
                            {product.sourceAssetIds.length
                              ? `${product.sourceAssetIds.length} 份已绑定`
                              : '未绑定素材'}
                          </StatusChip>
                          {baseUrl && (
                            <button
                              className="text-button"
                              data-testid={`product-assets-open-${product.id}`}
                              onClick={() => setRelationProductId(product.id)}
                            >
                              查看关系
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <StatusChip tone="neutral">
                          <Link2 size={12} />
                          {product.source}
                        </StatusChip>
                      </td>
                      <td>{product.stock.toLocaleString()}</td>
                      <td>
                        <div className="product-status-stack">
                          <StatusChip tone={identityError || product.issue ? 'amber' : 'green'}>
                            {identityError || (product.issue ? <><AlertCircle size={12} />{product.status}</> : <><Check size={12} />{product.status}</>)}
                          </StatusChip>
                          <StatusChip tone={canonicalCopy.tone} title={canonicalCopy.detail}>{canonicalCopy.label}</StatusChip>
                          {product.canonicalScope?.read_mode && <small>读取模式：{product.canonicalScope.read_mode}</small>}
                          {product.canonicalScope?.canonical_product_id && <small>规范商品：{product.canonicalScope.canonical_product_id}</small>}
                          {product.canonicalScope?.listing_id && <small>店铺刊登：{product.canonicalScope.listing_id}</small>}
                          {product.canonicalScope?.listing_count !== undefined && <small>刊登数量：{product.canonicalScope.listing_count}</small>}
                        </div>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => checkImages(product.id)}
                          disabled={!baseUrl || productListUnavailable}
                        >
                          主图检查
                        </button>
                        <button
                          className="text-button"
                          onClick={() => { setImageGenerationError(''); setImageGenerationMode(product.sourceAssetIds.length ? 'optimize' : 'create'); setImageGenerationTarget(target); setImageGenerationCount('1') }}
                          disabled={!baseUrl || productListUnavailable || Boolean(identityError) || Boolean(canonicalUnverified) || !product.factsConfirmed}
                          title={!product.factsConfirmed ? '请先确认商品事实' : canonicalUnverified ? canonicalCopy.detail : undefined}
                        >
                          生成图片 <ImageIcon size={14} />
                        </button>
                        <button
                          className="text-button"
                          onClick={() => onSelectTarget(target)}
                          disabled={
                            !baseUrl ||
                            productListUnavailable ||
                            Boolean(identityError) ||
                            Boolean(canonicalUnverified)
                          }
                          title={
                            identityError ??
                            (canonicalUnverified
                              ? canonicalCopy.detail
                              : !baseUrl
                                ? '配置 API 后可创建真实任务'
                                : undefined)
                          }
                        >
                          创建任务 <ArrowRight size={14} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <PackageSearch size={22} />
              <b>没有匹配商品</b>
              <span>调整搜索条件，或重新同步平台商品。</span>
            </div>
          )}
        </div>
        <div className="table-footer">
          <span>
            {effectiveProductTotal
              ? `显示 ${productPage * productPageSize + 1}–${Math.min((productPage + 1) * productPageSize, effectiveProductTotal)} / ${effectiveProductTotal} 个匹配商品`
              : '显示 0 个商品'}
          </span>
          <div>
            <button
              onClick={() => setProductPage((page) => Math.max(0, page - 1))}
              disabled={productPage === 0 || loading}
            >
              上一页
            </button>
            <span aria-live="polite">
              第 {productPage + 1} / {productPageCount} 页
            </span>
            <button
              onClick={() =>
                setProductPage((page) =>
                  Math.min(productPageCount - 1, page + 1),
                )
              }
              disabled={productPage >= productPageCount - 1 || loading}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
      {importOpen && (
        <DialogFrame
          testId="import-product-dialog"
          kicker="PRODUCT IMPORT"
          title="导入待创建商品"
          onClose={() => setImportOpen(false)}
          busy={importing}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setImportOpen(false)}
                disabled={importing}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => void importLocalProduct()}
                disabled={importing || importAssetsLoading}
              >
                {importing ? '导入中…' : '确认导入'}
              </button>
            </>
          }
        >
          <div className="dialog-form">
            <label htmlFor="import-product-title">
              商品名称
              <input
                id="import-product-title"
                data-dialog-initial-focus
                value={importDraft.title}
                onChange={(event) => {
                  setImportDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                  setImportError('')
                }}
                maxLength={200}
              />
            </label>
            <label htmlFor="import-product-platform">
              目标平台
              <select
                id="import-product-platform"
                value={importDraft.platform}
                onChange={(event) =>
                  setImportDraft((current) => ({
                    ...current,
                    platform: event.target.value as PlatformId,
                  }))
                }
              >
                {Object.entries(platformNames).map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="import-product-category">
              平台类目
              <input
                id="import-product-category"
                value={importDraft.category}
                onChange={(event) => {
                  setImportDraft((current) => ({
                    ...current,
                    category: event.target.value,
                  }))
                  setImportError('')
                }}
                maxLength={200}
              />
            </label>
            <div className="dialog-form-row">
              <label htmlFor="import-product-price">
                价格
                <input
                  id="import-product-price"
                  inputMode="decimal"
                  value={importDraft.price}
                  onChange={(event) => {
                    setImportDraft((current) => ({
                      ...current,
                      price: event.target.value,
                    }))
                    setImportError('')
                  }}
                />
              </label>
              <label htmlFor="import-product-stock">
                库存
                <input
                  id="import-product-stock"
                  inputMode="numeric"
                  value={importDraft.stock}
                  onChange={(event) => {
                    setImportDraft((current) => ({
                      ...current,
                      stock: event.target.value,
                    }))
                    setImportError('')
                  }}
                />
              </label>
            </div>
            <fieldset className="import-asset-picker">
              <legend>默认商品素材（可选）</legend>
              {importAssetsLoading ? (
                <LoadingState label="正在读取可用素材…" />
              ) : importAssets.length ? (
                <div className="import-asset-options">
                  {importAssets.map((asset) => (
                    <label key={asset.id}>
                      <input
                        type="checkbox"
                        checked={selectedImportAssetIds.includes(asset.id)}
                        onChange={() =>
                          setSelectedImportAssetIds((current) =>
                            current.includes(asset.id)
                              ? current.filter((id) => id !== asset.id)
                              : [...current, asset.id],
                          )
                        }
                      />
                      <span>
                        <b>{asset.name}</b>
                        <small>
                          {asset.scanStatus === 'clean' &&
                          asset.rightsStatus === 'approved'
                            ? '可用于后续生成'
                            : '需先完成扫描与权益确认'}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <small className="muted-help">
                  暂无素材；可先在素材库上传，导入后再绑定。
                </small>
              )}
              <small className="muted-help">
                绑定会随商品导入请求提交到服务端；取消导入不会产生绑定。
              </small>
            </fieldset>
            {importError && <ErrorNotice message={importError} compact />}
          </div>
        </DialogFrame>
      )}
      {groupConfirmOpen && (
        <DialogFrame
          testId="task-group-confirm-dialog"
          kicker="BATCH TASKS"
          title={`创建 ${selectedTargets.length} 个店铺子任务`}
          onClose={() => setGroupConfirmOpen(false)}
          busy={groupCreating}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setGroupConfirmOpen(false)}
                disabled={groupCreating}
              >
                返回检查
              </button>
              <button
                className="danger-action"
                onClick={() => void createGroup()}
                disabled={groupCreating}
              >
                {groupCreating ? '创建中…' : '确认创建任务组'}
              </button>
            </>
          }
        >
          <p>
            每个“商品 + 平台 +
            店铺”目标会创建独立子任务，分别保存规则、版本和发布回执。
          </p>
          <div className="dialog-summary">
            {selectedTargets.map((item) => (
              <div key={batchTargetKey(item)}>
                <StatusChip tone="green">
                  {platformNames[item.platform]}
                </StatusChip>
                <span>{item.title}</span>
                <small>{item.storeName}</small>
              </div>
            ))}
          </div>
          {error && <ErrorNotice message={error} compact />}
        </DialogFrame>
      )}
      {imageReviewMessage && (
        <DialogFrame
          testId="image-review-dialog"
          kicker="IMAGE REVIEW"
          title="主图检查结果"
          onClose={() => setImageReviewMessage('')}
          actions={
            <button
              className="primary"
              onClick={() => setImageReviewMessage('')}
            >
              知道了
            </button>
          }
        >
          <p role="status">{imageReviewMessage}</p>
        </DialogFrame>
      )}
      {relationProductId && baseUrl && (
        <ProductAssetRelationDialog
          baseUrl={baseUrl}
          productId={relationProductId}
          onClose={() => setRelationProductId('')}
          onContinue={(product) => {
            setRelationProductId('')
            onSelectTarget({
              productId: product.id,
              platform: product.platform,
              title: product.title,
              remoteId: product.remoteId,
              accountId: product.accountId,
              storeName: product.storeName,
            })
          }}
        />
      )}
      {imageGenerationTarget && (
        <DialogFrame
          testId="image-generation-dialog"
          kicker="IMAGE GENERATION"
          title={`为「${imageGenerationTarget.title}」生成图片`}
          onClose={() => setImageGenerationTarget(null)}
          busy={imageGenerationBusy}
          actions={<><button className="secondary" onClick={() => setImageGenerationTarget(null)} disabled={imageGenerationBusy}>取消</button><button className="primary" onClick={() => void submitImageGeneration()} disabled={imageGenerationBusy}>{imageGenerationBusy ? '提交中…' : '确认生成'}</button></>}
        >
          <div className="dialog-form">
            <div className="info-notice" role="status">将进入真实图片任务队列；生成完成后仍需安全扫描、人工审核和候选选择，不会直接发布。</div>
            <label htmlFor="image-generation-direction">生成方向<textarea id="image-generation-direction" data-dialog-initial-focus value={imageGenerationDirection} onChange={event => { setImageGenerationDirection(event.target.value); setImageGenerationError('') }} maxLength={500} rows={4} /></label>
            <label htmlFor="image-generation-count">候选数量<input id="image-generation-count" inputMode="numeric" value={imageGenerationCount} onChange={event => { setImageGenerationCount(event.target.value); setImageGenerationError('') }} /></label>
            {imageGenerationError && <div className="error-notice" role="alert">{imageGenerationError}</div>}
          </div>
        </DialogFrame>
      )}
    </div>
  )
}

type TaskContext = { task: Task; version: ContentVersion }

const contentVersionStateLabel = (state: string) =>
  ({
    draft: '草稿',
    review_required: '待审核',
    changes_requested: '待修改',
    approved: '已批准',
    rejected: '已退回',
  })[state] ?? '状态待确认'
const timelineEventLabels: Record<string, string> = {
  task_created: '任务已创建',
  'task.created': '任务已创建',
  task_answered: '需求已确认',
  'task.answers_submitted': '需求已确认',
  direction_selected: '创意方向已选择',
  'task.direction_selected': '创意方向已选择',
  plan_confirmed: '制作方案已确认',
  'task.plan_confirmed': '制作方案已确认',
  content_generated: '内容已生成',
  'content.generated': '内容已生成',
  content_reviewed: '内容已检查',
  'content.review_decided': '审核决定已记录',
  content_approved: '内容已批准',
  'content.approved': '内容已批准',
  publish_prepared: '发布预览已准备',
  'publish.prepared': '发布预览已准备',
  publish_confirmed: '发布请求已确认',
  'publish.confirmed': '发布请求已确认',
  publish_rejected: '平台已驳回',
  'publish.rejected': '平台已驳回',
  publish_delivered: '平台已交付',
  'publish.observation': '平台回执已更新',
  'task.facts_unblocked': '商品事实已确认',
  'task.resumed': '任务已恢复',
  'task.cloned': '任务已复制',
  'task.sku_split': '任务已按 SKU 拆分',
  'generation.requested': '内容生成已排队',
  'generation.failed': '内容生成失败',
  'generation.deferred': '内容生成已暂缓',
  'content.delivery_expired': '内容交付已过期',
  'publish.reconcile_requested': '已请求重新对账',
}
const timelineEventLabel = (eventType: string) =>
  timelineEventLabels[eventType] ?? '任务状态已更新'
const persistedAnswerLabels: Record<string, string> = {
  goal: '业务目标',
  audience: '目标受众',
  scene: '使用场景',
  constraints: '内容约束',
  output_count: '内容组数',
  price_policy: '价格表达规则',
  activity_valid_until: '活动有效期',
}
const restoreConversationReplies = (events: TaskTimelineEvent[]) => {
  const replies: Array<{ question: string; answer: string }> = []
  for (const event of events) {
    if (
      event.event_type !== 'task.answers_submitted' ||
      !event.payload ||
      typeof event.payload !== 'object'
    )
      continue
    const answers = event.payload.answers
    if (!answers || typeof answers !== 'object' || Array.isArray(answers))
      continue
    for (const [key, value] of Object.entries(
      answers as Record<string, unknown>,
    )) {
      const label = persistedAnswerLabels[key]
      if (
        !label ||
        value === undefined ||
        value === null ||
        typeof value === 'object'
      )
        continue
      const answer = String(value).trim()
      if (answer) replies.push({ question: label, answer })
    }
  }
  return replies
    .filter(
      (reply, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.question === reply.question &&
            candidate.answer === reply.answer,
        ) === index,
    )
    .slice(-8)
}

function ProductDetailPreview({
  content,
  title,
  product,
  demoMode,
}: {
  content: ContentVersion | null
  title: string
  product: ApiProduct | null
  demoMode: boolean
}) {
  const [imageIndex, setImageIndex] = useState(0)
  const [moduleFilter, setModuleFilter] = useState<
    'all' | 'fact' | 'creative' | 'pending'
  >('all')
  const [selectedColor, setSelectedColor] = useState('')
  const [selectedSize, setSelectedSize] = useState('')
  // Platform/fixture image references are not browser URLs. Keep them in the
  // authoritative product data, but never hand unsupported schemes to <img>:
  // that creates noisy ERR_UNKNOWN_URL_SCHEME failures and a misleading broken
  // preview. A real media URL is rendered only after the storage/media gateway
  // has returned one.
  const images =
    product?.images?.filter((image) =>
      /^(?:https?:|data:|blob:)/u.test(image),
    ) ?? []
  const attributes = Object.entries(product?.attributes ?? {})
    .filter(([, value]) => value.trim())
    .slice(0, 8)
  const colors = [
    ...new Set(
      (product?.skus ?? [])
        .map((sku) => sku.attributes?.颜色)
        .filter((value): value is string => Boolean(value)),
    ),
  ]
  const sizes = [
    ...new Set(
      (product?.skus ?? [])
        .map((sku) => sku.attributes?.尺码)
        .filter((value): value is string => Boolean(value)),
    ),
  ]
  const colorKey = colors.join('\u0000')
  const sizeKey = sizes.join('\u0000')
  useEffect(() => {
    setImageIndex(0)
    setSelectedColor(colors[0] ?? '')
    setSelectedSize(sizes[0] ?? '')
  }, [product?.id, colorKey, sizeKey])
  const topLevelContent = evidenceSafeTopLevelContent(content?.body)
  const detailModules = (content?.body.modules ?? []).filter(
    (module) =>
      ![
        'specifications',
        'sku',
        'real_images',
        'platform',
      ].includes(module.key),
  )
  const moduleKind = (
    module: NonNullable<ContentVersion['body']['modules']>[number],
  ) =>
    module.contentKind ??
    (module.body.startsWith('[待确认]') ? 'pending' : 'fact')
  const visibleModules = detailModules.filter(
    (module) => moduleFilter === 'all' || moduleKind(module) === moduleFilter,
  )
  const moduleLabels = {
    all: '全部',
    fact: '事实内容',
    creative: '创意表达',
    pending: '待确认',
  } as const
  return (
    <section className="product-detail-preview" aria-label="商品详情页预览">
      <div className="preview-heading">
        <div>
          <span className="section-kicker">STOREFRONT PREVIEW</span>
          <h3>商品详情页预览</h3>
        </div>
        <StatusChip tone="blue">草稿 · 未发布</StatusChip>
      </div>
      <div className="storefront-card">
        <div className="storefront-gallery">
          <div className="gallery-main">
            {images[imageIndex] ? (
              <img src={images[imageIndex]} alt={`${title}商品主图`} />
            ) : (
              <div className="gallery-empty">
                <ShoppingBag size={36} />
                <span>尚未绑定商品图片</span>
              </div>
            )}
          </div>
          {images.length > 1 && (
            <div className="gallery-thumbs">
              {images.slice(0, 5).map((image, index) => (
                <button
                  key={`${index}-${image.slice(0, 24)}`}
                  className={imageIndex === index ? 'active' : ''}
                  onClick={() => setImageIndex(index)}
                  aria-label={`查看商品图 ${index + 1}`}
                >
                  <img src={image} alt={`商品图 ${index + 1} 缩略图`} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="storefront-info">
          <div className="storefront-tags">
            <span>
              {platformNames[product?.platform ?? ''] ?? '待选平台'} ·{' '}
              {product?.category ?? '品类待确认'}
            </span>
            <span>{product?.factsConfirmed ? '事实已确认' : '事实待确认'}</span>
          </div>
          <h4>{content?.body.title ?? title}</h4>
          <p className="storefront-subtitle">
            {content
              ? topLevelContent.notice
              : '内容尚未生成；当前只展示已保存的商品事实。'}
          </p>
          {!product?.factsConfirmed && (
            <p className="fact-safety-note">
              标记为“待确认”的材质、性能和功效不得写成确定性卖点
            </p>
          )}
          <div className="storefront-price">
            {typeof product?.price === 'number' && product.price > 0 ? (
              <>
                <span>¥</span>
                <strong>{product.price.toLocaleString()}</strong>
                <em>起</em>
                <small>来自商品事实</small>
              </>
            ) : (
              <strong className="price-pending">价格待确认</strong>
            )}
          </div>
          {colors.length > 0 && (
            <div className="storefront-spec">
              <b>颜色</b>
              <div>
                {colors.map((color) => (
                  <button
                    key={color}
                    className={selectedColor === color ? 'selected' : ''}
                    aria-pressed={selectedColor === color}
                    onClick={() => setSelectedColor(color)}
                  >
                    {color}
                  </button>
                ))}
              </div>
            </div>
          )}
          {sizes.length > 0 && (
            <div className="storefront-spec">
              <b>尺码</b>
              <div>
                {sizes.map((size) => (
                  <button
                    key={size}
                    className={selectedSize === size ? 'selected' : ''}
                    aria-pressed={selectedSize === size}
                    onClick={() => setSelectedSize(size)}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="storefront-benefits">
            <span>库存 {product?.stock?.toLocaleString() ?? '待确认'}</span>
            <span>{product?.skuCount ?? 0} 个 SKU</span>
            <span>发布前需人工审核</span>
          </div>
        </div>
      </div>
      <div className="detail-sections">
        <div className="detail-section-head">
          <span>顶层详情与卖点</span>
          <small>{content ? '证据边界检查' : '生成后检查'}</small>
        </div>
        {content ? (
          <div className="detail-rule-note" role="note" aria-label="顶层内容恢复提示">
            <AlertCircle size={14} aria-hidden="true" />
            <span>{topLevelContent.notice}</span>
          </div>
        ) : (
          <div className="empty-inline">尚未生成商品卖点</div>
        )}
        <div className="detail-section-head">
          <span>规格参数</span>
          <small>{product?.category ?? '品类待确认'}</small>
        </div>
        {attributes.length ? (
          <div className="spec-table">
            {attributes.map(([key, value]) => (
              <span key={key}>
                <b>{key}</b>
                {value}
              </span>
            ))}
          </div>
        ) : (
          <div className="empty-inline">尚未保存可展示参数</div>
        )}
        {detailModules.length > 0 && (
          <>
            <div className="detail-section-head">
              <span>完整详情模块</span>
              <small>
                {visibleModules.length} / {detailModules.length} 个可审阅模块
              </small>
            </div>
            <div
              className="module-filter"
              role="tablist"
              aria-label="详情模块类型筛选"
            >
              {(
                Object.keys(moduleLabels) as Array<keyof typeof moduleLabels>
              ).map((filter) => (
                <button
                  key={filter}
                  className={moduleFilter === filter ? 'active' : ''}
                  onClick={() => setModuleFilter(filter)}
                  role="tab"
                  aria-selected={moduleFilter === filter}
                >
                  {moduleLabels[filter]}{' '}
                  <em>
                    {filter === 'all'
                      ? detailModules.length
                      : detailModules.filter(
                          (module) => moduleKind(module) === filter,
                        ).length}
                  </em>
                </button>
              ))}
            </div>
            <div className="detail-module-grid">
              {visibleModules.map((module) => {
                const kind = moduleKind(module)
                const decision = moduleDecisionPresentation(module)
                return (
                  <article
                    className={`${
                      kind === 'pending'
                        ? 'pending'
                        : kind === 'creative'
                          ? 'creative'
                          : ''
                    } decision-${decision.disposition}`.trim()}
                    key={module.key}
                  >
                    <div>
                      <b>{module.title}</b>
                      <span>{decision.label}</span>
                    </div>
                    {decision.bodyVisible && <p>{module.body}</p>}
                    {kind === 'pending' && module.pendingReason && (
                      <small>待确认原因：{module.pendingReason}</small>
                    )}
                    {decision.bodyVisible && module.imageGuidance && (
                      <small>配图：{module.imageGuidance}</small>
                    )}
                    <DetailDecisionContract module={module} />
                  </article>
                )
              })}
            </div>
            {visibleModules.length === 0 && (
              <div className="empty-inline">当前筛选没有对应模块</div>
            )}
          </>
        )}
        <div className="detail-section-head">
          <span>规则提示</span>
          <small>发布前仍需人工确认</small>
        </div>
        <div className="detail-rule-note">
          <ShieldCheck size={15} />
          <span>
            {demoMode
              ? '离线演示规则：待确认事实不得写成确定性卖点；不可用于真实发布。'
              : content?.ruleVersionIds.length
                ? `服务端内容版本规则：${content.ruleVersionIds.join('、')}`
                : '服务端当前内容版本尚未返回规则版本。'}
          </span>
        </div>
      </div>
    </section>
  )
}

function ImageGenerationJobDiscovery({ baseUrl }: { baseUrl?: string }) {
  const [jobs, setJobs] = useState<ImageGenerationJobListItem[] | null>(null)
  const [initialError, setInitialError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [reload, setReload] = useState(0)
  const lastSuccessfulJobsRef = useRef<ImageGenerationJobListItem[]>([])
  useEffect(() => {
    if (!baseUrl) {
      lastSuccessfulJobsRef.current = []
      setLoading(false)
      setJobs(null)
      setInitialError('')
      setRefreshError('')
      return
    }
    let active = true
    let inFlight = false
    const load = (showLoading: boolean) => {
      if (inFlight) return
      inFlight = true
      if (showLoading && !lastSuccessfulJobsRef.current.length) setLoading(true)
      void fetchImageGenerationJobs(baseUrl)
        .then(value => {
          if (!active) return
          lastSuccessfulJobsRef.current = value.items
          setJobs(value.items)
          setInitialError('')
          setRefreshError('')
        })
        .catch(cause => {
          if (!active) return
          const message = describeApiError(cause)
          if (lastSuccessfulJobsRef.current.length) {
            setJobs(lastSuccessfulJobsRef.current)
            setRefreshError(message)
          } else {
            setInitialError(message)
          }
        })
        .finally(() => {
          inFlight = false
          if (active && showLoading) setLoading(false)
        })
    }
    load(true)
    const timer = window.setInterval(() => load(false), 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [baseUrl, reload])
  const stateLabels: Record<string, string> = { queued: '排队中', running: '处理中', succeeded: '生成完成，等待审查', failed: '生成失败', pending: '归档中，等待安全扫描', partial: '部分归档，等待补偿', external_unarchived: '归档未确认，等待对账', provider_reserved: imageGenerationExecutionLabel('provider_reserved'), provider_dispatching: imageGenerationExecutionLabel('provider_dispatching'), provider_started: imageGenerationExecutionLabel('provider_started'), outcome_unknown: imageGenerationExecutionLabel('outcome_unknown') }
  if (!baseUrl) return <div className="info-notice" role="status">配置 API 后才能发现真实图片任务。</div>
  const listReady = !loading && jobs !== null
  return <section className="panel image-generation-discovery" aria-labelledby="image-job-discovery-title" aria-busy={loading}>
    <div className="detail-section-head"><div><span className="section-kicker">IMAGE TASKS</span><h3 id="image-job-discovery-title">图片任务</h3></div><StatusChip tone="blue">{loading ? '读取中…' : `${jobs?.length ?? 0} 个任务`}</StatusChip></div>
    {initialError && !loading && <ErrorNotice message={`图片任务列表读取失败：${initialError}`} onRetry={() => setReload(value => value + 1)} />}
    {refreshError && listReady && <ErrorNotice message={`图片任务自动刷新失败：${refreshError}。已保留上次成功数据。`} onRetry={() => setReload(value => value + 1)} />}
    {listReady && !initialError && jobs?.length === 0 && <div className="empty-state"><ImageIcon size={22} /><b>暂无图片任务</b><span>从商品任务进入图片生成；系统不会自动创建演示任务。</span></div>}
    {listReady && !initialError && Boolean(jobs?.length) && <div className="image-generation-job-list">{jobs?.map(job => <div className="image-generation-job-row" key={job.jobId}>
      <div><b>{job.productTitle ?? `商品 ${job.productId}`}</b><span>{job.platform ?? '平台待恢复'} · {job.storeName ?? '店铺身份待恢复'} · {stateLabels[job.executionState ?? (job.archiveState !== 'archived' ? job.archiveState : job.state)] ?? '状态待确认'} · {job.candidateCount} 张候选</span></div>
      <StatusChip tone={job.executionState === 'outcome_unknown' || job.state === 'failed' || job.archiveState === 'external_unarchived' ? 'amber' : job.state === 'succeeded' && job.archiveState === 'archived' ? 'green' : 'blue'}>{stateLabels[job.executionState ?? (job.archiveState !== 'archived' ? job.archiveState : job.state)] ?? '状态待确认'}</StatusChip>
      <button className="text-button" type="button" onClick={() => { window.location.href = `${window.location.pathname}?image_job=${encodeURIComponent(job.jobId)}` }}>查看任务 <ArrowRight size={14} /></button>
    </div>)}</div>}
  </section>
}

function ImageGenerationJobPanel({ baseUrl, jobId }: { baseUrl?: string; jobId: string }) {
  const [job, setJob] = useState<ImageGenerationJob | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [reload, setReload] = useState(0)
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const [imageReloads, setImageReloads] = useState<Record<string, number>>({})
  const [candidatePage, setCandidatePage] = useState(1)
  const [selectedVisualRefs, setSelectedVisualRefs] = useState<string[]>([])
  const [selectionReason, setSelectionReason] = useState('人工确认候选图并进入内容版本审阅')
  const [selectionState, setSelectionState] = useState<'idle' | 'submitting' | 'succeeded' | 'failed'>('idle')
  const [selectionMessage, setSelectionMessage] = useState('')
  const [selectionNotice, setSelectionNotice] = useState('')
  const selectionErrorRef = useRef<HTMLDivElement>(null)
  const [retrying, setRetrying] = useState(false)
  const pollDelayRef = useRef(IMAGE_JOB_INITIAL_POLL_DELAY_MS)
  // A safe retry creates a new durable job. Keep polling that returned job
  // instead of continuing to read the failed predecessor from the deep link.
  const currentJobId = job?.jobId ?? jobId
  useEffect(() => {
    if (!baseUrl) { setLoading(false); return }
    let active = true
    let timer: number | undefined
    let shouldPoll = true
    const read = async () => {
      try {
        setLoading(true)
        const next = await fetchImageGenerationJob(baseUrl, currentJobId)
        shouldPoll = shouldPollImageJob(next)
        if (active) { setJob(next); setError(''); pollDelayRef.current = nextImageJobPollDelay(pollDelayRef.current, 'success') }
      } catch (cause) {
        shouldPoll = true
        pollDelayRef.current = nextImageJobPollDelay(pollDelayRef.current, 'error')
        if (active) setError(describeApiError(cause))
      } finally {
        if (active) {
          // A terminal read must clear the busy state too; otherwise the
          // stopped poll leaves the panel permanently busy and disables its
          // recovery/refresh controls.
          setLoading(false)
        }
        if (active && shouldPoll) {
          // One scheduled read at a time prevents a slow API response from
          // creating overlapping requests. Hidden tabs still re-check at a
          // low cadence and immediately recover when the tab is visible.
          timer = window.setTimeout(() => { if (active) void read() }, visibleImageJobPollDelay(pollDelayRef.current, document.hidden))
        }
      }
    }
    void read()
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [baseUrl, currentJobId, reload, job?.state])
  useEffect(() => { setCandidatePage(1) }, [currentJobId])
  const labels: Record<string, string> = { queued: '排队中', leased: '已分配执行权', running: '处理中', succeeded: '生成完成，等待候选审查', failed: '生成失败', provider_reserved: imageGenerationExecutionLabel('provider_reserved'), provider_dispatching: imageGenerationExecutionLabel('provider_dispatching'), provider_started: imageGenerationExecutionLabel('provider_started'), outcome_unknown: imageGenerationExecutionLabel('outcome_unknown') }
  const archiveLabels: Record<string, string> = { pending: '归档中', partial: '部分归档', archived: '已归档', external_unarchived: '外部归档未确认' }
  const gateLabels: Record<string, string> = { pending: '待归档', archived: '已归档', partial: '部分归档', external_unarchived: '归档未确认', quarantined: '扫描隔离', clean: '扫描通过', blocked: '扫描阻断', approved: '权益已确认', rejected: '权益拒绝', unreviewed: '待人工审核', passed: '人工审核通过', not_checked: '真实性未检查', unverified: '真实性未确认' }
  const toggleVisual = (visualRef: string, allowed: boolean) => {
    if (!allowed) {
      setSelectionNotice('这张候选图尚未满足归档、安全扫描、权益、真实性或人工审核门禁，暂不能选择。')
      return
    }
    if (!selectedVisualRefs.includes(visualRef) && selectedVisualRefs.length >= 6) {
      setSelectionNotice('最多选择 6 张候选图，请先取消一张再继续。')
      return
    }
    setSelectedVisualRefs(current => current.includes(visualRef) ? current.filter(item => item !== visualRef) : [...current, visualRef])
    setSelectionNotice('')
    setSelectionState('idle'); setSelectionMessage('')
  }
  const submitVisualSelection = async () => {
    if (!baseUrl || !job?.taskId || !job.contentVersionId || !selectedVisualRefs.length) return
    setSelectionState('submitting'); setSelectionMessage('')
    try {
      const versions = await fetchContentVersions(baseUrl, job.taskId)
      const current = versions.find(version => version.id === job.contentVersionId)
      if (!current) throw new Error('当前内容版本不存在或已变化，请返回任务页刷新')
      const selected = await selectVisualCandidates(baseUrl, current.id, selectedVisualRefs, current.revision, selectionReason.trim(), `merchant-studio-visual-selection-${job.jobId}-${current.revision}`)
      setSelectionState('succeeded'); setSelectionMessage(`已提交 ${selected.visualSelection.count} 张候选，生成新的待审核内容版本 ${selected.content_version_id}。`)
    } catch (cause) {
      setSelectionState('failed')
      setSelectionMessage(describeApiError(cause))
      window.requestAnimationFrame(() => selectionErrorRef.current?.focus())
    }
  }
  const executionState = job?.executionState
  const displayState = !job ? '' : executionState && ['provider_reserved', 'provider_dispatching', 'provider_started', 'outcome_unknown', 'dispatching'].includes(executionState) ? executionState : job.archiveState === 'pending' ? 'archiving' : job.archiveState === 'partial' ? 'partial_archive' : job.archiveState === 'external_unarchived' ? 'external_unarchived' : job.state
  const displayStateLabels: Record<string, string> = { ...labels, archiving: '归档中，等待安全扫描', partial_archive: '部分归档，等待补偿', external_unarchived: '归档未确认，等待对账' }
  const displayStateTone = displayState === 'failed' || displayState === 'outcome_unknown' || displayState === 'external_unarchived' ? 'amber' : displayState === 'succeeded' && job?.archiveState === 'archived' ? 'green' : 'blue'
  const candidatePageData = getImageCandidatePage(job?.images?.map((src, index) => ({ src, index })) ?? [], candidatePage)
  const focusImageError = () => document.getElementById('image-job-error')?.focus()
  const retrySafeImageJob = async () => {
    if (!baseUrl || !job || !imageGenerationRetryAllowed({ state: job.state, executionState: job.executionState, nextActionAllowed: job.nextAction?.allowed })) return
    setRetrying(true)
    try { const next = await retryImageGeneration(baseUrl, job.jobId, job.revision); setJob(current => current ? { ...current, jobId: next.job_id, state: next.state, archiveState: 'pending', errorCode: null, errorMessage: null } : current); setReload(value => value + 1) }
    catch (cause) { setError(describeApiError(cause)) }
    finally { setRetrying(false) }
  }
  if (!baseUrl) return <div className="info-notice" role="status">配置 API 后才能读取真实图片任务。</div>
  const isTerminal = job?.state === 'succeeded' || job?.state === 'failed'
  return <section className="panel image-generation-job-panel" aria-labelledby="image-job-title" aria-busy={loading}>
    <div className="detail-section-head"><div><span className="section-kicker">IMAGE JOB</span><h3 id="image-job-title">图片生成任务</h3></div><StatusChip tone={displayStateTone}>{loading && !job ? '读取中…' : displayStateLabels[displayState] ?? '状态待确认'}</StatusChip></div>
    <div className="info-notice" role="status" aria-live="polite" aria-atomic="true">{job ? `任务 ${job.jobId} · 商品 ${job.productId} · 最后更新 ${new Date(job.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '正在读取任务状态…'}</div>
    {error && <div className="error-notice image-job-read-error" role="alert" aria-atomic="true"><span>任务状态读取失败：{error}。已保留上次可信状态。</span><button className="secondary-button" type="button" onClick={() => { setError(''); setReload(value => value + 1) }} disabled={loading}>刷新任务状态</button></div>}
    {job && <dl className="image-job-evidence" aria-label="图片执行证据"><div><dt>执行状态</dt><dd>{labels[job.executionState ?? ''] ?? job.executionState ?? '未记录'}</dd></div><div><dt>归档状态</dt><dd>{archiveLabels[job.archiveState] ?? '状态未知'}</dd></div><div><dt>执行尝试</dt><dd>{job.executionAttempt ?? '未记录'}</dd></div><div><dt>Provider 请求</dt><dd>{job.providerRequestId ?? '尚未确认'}</dd></div><div><dt>任务版本</dt><dd>{job.revision}</dd></div></dl>}
    {job?.errorMessage && <div id="image-job-error" className="error-notice" role="alert" tabIndex={-1}><AlertCircle size={16} /><span>{job.errorCode ?? 'IMAGE_GENERATION_FAILED'}：{job.errorMessage}</span></div>}
    {job?.availabilityWarning && <div className="info-notice"><ShieldCheck size={16} /><span>{job.availabilityWarning}</span></div>}
    {!job && loading && <div className="image-candidate-loading" aria-hidden="true">
      {[0, 1, 2].map((slot) => <div className="image-candidate-skeleton" key={`image-candidate-skeleton-${slot}`}><div className="image-candidate-skeleton-media" /><div className="image-candidate-skeleton-line image-candidate-skeleton-line-wide" /><div className="image-candidate-skeleton-line" /></div>)}
    </div>}
    {job?.images?.length ? <>
      <div className="image-candidate-grid" aria-label={`已归档图片候选，第 ${candidatePageData.page} 页，共 ${candidatePageData.pageCount} 页`}>{candidatePageData.items.map(({ src, index }) => {
      const output = job.outputs[index]
      const visualRef = output?.visualRef ?? `ordinal-${index}`
      const gate = output?.gate
      const failed = failedImages.has(visualRef)
      return <figure key={visualRef} className={gate?.selectable ? 'candidate-ready' : 'candidate-blocked'}>
        {failed ? <div className="image-candidate-fallback" role="alert"><span>候选图片读取失败，当前任务状态和候选门禁仍保留。</span><button className="text-button" type="button" onClick={() => { setFailedImages(current => { const next = new Set(current); next.delete(visualRef); return next }); setImageReloads(current => ({ ...current, [visualRef]: (current[visualRef] ?? 0) + 1 })) }} aria-label={`重新读取图片候选 ${index + 1}`}>重新读取</button></div> : <img key={`${visualRef}-${imageReloads[visualRef] ?? 0}`} src={src} alt={`图片候选 ${index + 1}，${gate?.selectable ? '可进入后续选择' : '尚不可选择'}`} loading={index > 0 ? 'lazy' : 'eager'} onError={() => setFailedImages(current => new Set(current).add(visualRef))} />}
        <figcaption><strong>候选 {index + 1}</strong><span>{gate?.selectable ? '满足选择门禁' : '暂不可选择'}</span><div className="image-candidate-metadata" aria-label={`候选 ${index + 1} 归属与完整性摘要`}><span>任务：{job.jobId}</span><span>商品版本：v{job.sourceProductVersion}</span><span>来源素材：{job.sourceAssetIds.length ? `${job.sourceAssetIds.length} 个` : '无'}</span><span>生成：{new Date(output?.createdAt ?? job.createdAt).toLocaleString('zh-CN', { hour12: false })}</span><span>文件：{output ? `${output.mimeType} · ${Math.round(output.sizeBytes / 1024)} KB` : '未记录'}</span><span>SHA-256：{output?.sha256 ? `${output.sha256.slice(0, 12)}…` : '未记录'}</span>{output?.archiveReceiptId && <span>归档凭证：{output.archiveReceiptId}</span>}</div>{job.contentVersionId && <label className="candidate-select-control"><input type="checkbox" checked={selectedVisualRefs.includes(visualRef)} disabled={!gate?.selectable || selectionState === 'submitting'} aria-describedby={!gate?.selectable ? `candidate-gate-${index}` : undefined} onChange={() => toggleVisual(visualRef, Boolean(gate?.selectable))} />选择为{selectedVisualRefs[0] === visualRef ? '主图' : '辅图'}</label>}{gate && <div className="image-candidate-gates" aria-label={`候选 ${index + 1} 门禁状态`}><span>归档：{gateLabels[gate.archive] ?? gate.archive}</span><span>扫描：{gateLabels[gate.scan] ?? gate.scan}</span><span>权益：{gateLabels[gate.rights] ?? gate.rights}</span><span>审核：{gateLabels[output?.reviewStatus ?? ''] ?? output?.reviewStatus ?? '未知'}</span><span>真实性：{gateLabels[gate.authenticity] ?? gate.authenticity}</span></div>}{!gate?.selectable && <small id={`candidate-gate-${index}`}>不可选择：{gate?.blockers.length ? gate.blockers.join('；') : '尚未满足全部候选门禁'}</small>}</figcaption>
      </figure>
    })}</div>
      {candidatePageData.pageCount > 1 && <nav className="image-candidate-pagination" aria-label="图片候选分页"><button className="secondary-button" type="button" onClick={() => setCandidatePage(candidatePageData.page - 1)} disabled={candidatePageData.page === 1}>上一页</button><span aria-live="polite">第 {candidatePageData.page} / {candidatePageData.pageCount} 页 · 共 {candidatePageData.total} 张候选</span><button className="secondary-button" type="button" onClick={() => setCandidatePage(candidatePageData.page + 1)} disabled={candidatePageData.page === candidatePageData.pageCount}>下一页</button></nav>}
    </> : null}
    {job?.contentVersionId ? <div className="image-selection-panel" aria-label="候选选择"><label htmlFor="visual-selection-reason">选图原因（必填）</label><input id="visual-selection-reason" value={selectionReason} maxLength={300} onChange={event => { setSelectionReason(event.target.value); setSelectionNotice('') }} disabled={selectionState === 'submitting'} /><div className="action-row"><button className="primary-button" type="button" onClick={() => void submitVisualSelection()} disabled={selectionState === 'submitting' || !selectedVisualRefs.length || !selectionReason.trim()} aria-describedby="visual-selection-hint">{selectionState === 'submitting' ? '提交中…' : `提交选择（${selectedVisualRefs.length}/6）`}</button><span id="visual-selection-hint" className="muted-note">服务端会再次校验任务、商品、版本、扫描和审核状态。</span></div><div className="sr-only" role="status" aria-live="polite" aria-atomic="true">已选择 {selectedVisualRefs.length} 张候选{selectionNotice ? `。${selectionNotice}` : ''}</div>{selectionMessage && <div ref={selectionErrorRef} tabIndex={selectionState === 'failed' ? -1 : undefined} className={selectionState === 'failed' ? 'error-notice' : 'info-notice'} role={selectionState === 'failed' ? 'alert' : 'status'}>{selectionMessage}</div>}</div> : <div className="info-notice" role="status">当前图片任务未绑定内容版本，不能直接选择候选；请从营销任务进入内容版本后再操作。</div>}
    {job?.nextAction && <div className="info-notice" role={job.reconciliationRequired || imageGenerationNeedsReconciliation(job.executionState) ? 'alert' : 'status'}><ShieldCheck size={16} /><span>{imageGenerationNeedsReconciliation(job.executionState) ? '模型结果尚未确认；请先对账，系统不会再次生成或扣费。' : `下一步：${job.nextAction.label}`}</span>{job.nextAction.type === 'review_error' && job.nextAction.allowed && <button className="text-button" type="button" onClick={focusImageError}>查看失败原因</button>}{imageGenerationRetryAllowed({ state: job.state, executionState: job.executionState, nextActionAllowed: job.nextAction.allowed }) && !job.reconciliationRequired && ['IMAGE_GENERATION_NOT_CONFIGURED', 'IMAGE_GENERATION_PRE_PROVIDER_FAILED'].includes(job.errorCode ?? '') && <button className="text-button" type="button" onClick={() => void retrySafeImageJob()} disabled={retrying}>{retrying ? '重试入队中…' : '安全重试'}</button>}</div>}
    <div className="action-row"><button className="secondary-button" type="button" onClick={() => { setError(''); setFailedImages(new Set()); setReload(value => value + 1) }} disabled={loading} aria-label="刷新图片任务状态" aria-describedby="image-job-refresh-hint"><RefreshCw size={15} aria-hidden="true" />刷新任务状态</button><span id="image-job-refresh-hint" className="sr-only">刷新期间按钮不可重复操作，当前状态和候选不会被清空。</span>{imageGenerationProviderCallStarted(job?.executionState) && <span className="muted-note">Provider 已进入提交链路，结果未收口前禁止重复生成。</span>}{isTerminal && job?.images?.length ? <span className="muted-note">候选仍需单独通过人工审核和内容版本选择，生成完成不等于可发布。</span> : null}</div>
  </section>
}

function TaskWorkspace({
  openPublish,
  baseUrl,
  target,
  onContext,
  onSelectTarget,
  onTaskResolved,
  onBack,
  onBackToProducts,
}: {
  openPublish: () => void
  baseUrl?: string
  target?: Target
  onContext: (context: TaskContext | null) => void
  onSelectTarget: (target: Target) => void
  onTaskResolved: (taskId: string) => void
  onBack: () => void
  onBackToProducts: () => void
}) {
  const taskListRequestId = useRef(0)
  const taskProductsRequestId = useRef(0)
  const taskDirectionsRequestId = useRef(0)
  const [direction, setDirection] = useState(0)
  const [version, setVersion] = useState<'v4' | 'diff'>('v4')
  const [approved, setApproved] = useState(false)
  const [task, setTask] = useState<Task | null>(null)
  const [content, setContent] = useState<ContentVersion | null>(null)
  const [contentVersions, setRawContentVersions] = useState<ContentVersion[]>(
    [],
  )
  const setContentVersions: React.Dispatch<
    React.SetStateAction<ContentVersion[]>
  > = (next) =>
    setRawContentVersions((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      return resolved.map((version) => ({
        ...version,
        state: contentVersionStateLabel(
          version.state,
        ) as ContentVersion['state'],
      }))
    })
  const [reviewTab, setReviewTab] = useState<'findings' | 'versions'>(
    'findings',
  )
  const [findings, setFindings] = useState<ReviewFinding[]>([])
  const [reviewCategories, setReviewCategories] = useState<ReviewCategory[]>([])
  const [reviewStatus, setReviewStatus] = useState<
    'idle' | 'loading' | 'succeeded' | 'failed'
  >('idle')
  const [reviewError, setReviewError] = useState('')
  const [feedback, setFeedback] = useState<TaskFeedback[]>([])
  const [feedbackError, setFeedbackError] = useState('')
  const [feedbackReason, setFeedbackReason] = useState('')
  const [feedbackRating, setFeedbackRating] = useState<FeedbackRating | null>(
    null,
  )
  const [timeline, setTimeline] = useState<TaskTimelineEvent[]>([])
  const [timelineError, setTimelineError] = useState('')
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [findingDecision, setFindingDecision] = useState<ReviewFinding | null>(
    null,
  )
  const [findingDecisionReason, setFindingDecisionReason] = useState('')
  const [findingDecisionError, setFindingDecisionError] = useState('')
  const [findingDecisionSubmitting, setFindingDecisionSubmitting] =
    useState(false)
  const timelineTriggerRef = useRef<HTMLButtonElement>(null)
  const timelineModalRef = useRef<HTMLDivElement>(null)
  const timelineCloseRef = useRef<HTMLButtonElement>(null)
  const [contextCollapsed, setContextCollapsed] = useState(false)
  const [diffChanges, setDiffChanges] = useState<
    Array<{ path: string; before: unknown; after: unknown }>
  >([])
  const [requestText, setRequestText] = useState('')
  const [understanding, setUnderstanding] = useState<TaskUnderstanding | null>(
    null,
  )
  const [questionAnswers, setQuestionAnswers] = useState<
    Record<string, string>
  >({})
  const [conversationReplies, setConversationReplies] = useState<
    Array<{ question: string; answer: string }>
  >([])
  const [selectedCandidateId, setSelectedCandidateId] = useState('')
  const [taskList, setTaskList] = useState<Task[] | null>(null)
  const [taskTotal, setTaskTotal] = useState(0)
  const [taskProducts, setTaskProducts] = useState<ApiProduct[]>([])
  const [taskPage, setTaskPage] = useState(0)
  const [product, setProduct] = useState<ApiProduct | null>(null)
  const [taskListError, setTaskListError] = useState('')
  const [taskListLoading, setTaskListLoading] = useState(Boolean(baseUrl))
  const [taskProductsError, setTaskProductsError] = useState('')
  const [taskProductsLoading, setTaskProductsLoading] = useState(
    Boolean(baseUrl),
  )
  const requestInputRef = useRef<HTMLTextAreaElement>(null)
  const questionInputRef = useRef<HTMLInputElement>(null)
  const [remoteDirections, setRemoteDirections] = useState<
    TaskDirectionEvidence[] | null
  >(null)
  const [directionsError, setDirectionsError] = useState('')
  const [directionsReloadKey, setDirectionsReloadKey] = useState(0)
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [operation, setOperation] = useState('')
  const [error, setError] = useState('')
  const [taskCreationAttempted, setTaskCreationAttempted] = useState(false)
  const [titleEditOpen, setTitleEditOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleEditError, setTitleEditError] = useState('')
  const targetProductId = target?.productId
  const targetPlatform = target?.platform ?? 'taobao'
  const targetTitle = target?.title ?? '轻云防晒外套 2026'
  const topLevelDraft = evidenceSafeTopLevelContent(content?.body)
  const directionsData = resolveTaskDirections({
    baseUrl,
    remote: remoteDirections,
    error: directionsError,
  })
  const directions = directionsData.items
  const workflowSteps = resolveTaskWorkflow(task?.state, !baseUrl)
  const blockingFindings = findings.filter(
    (item) => item.severity === 'error',
  ).length
  const warningFindings = findings.filter(
    (item) => item.severity === 'warning',
  ).length
  const reviewScore =
    !content || reviewStatus !== 'succeeded'
      ? '—'
      : blockingFindings
        ? '—'
        : '100'
  const taskRuleVersionIds = (content?.ruleVersionIds ?? []).map(
    (_, index) => `服务端规则版本已绑定 ${index + 1}`,
  )
  const recentTimeline = timeline.slice().reverse().slice(0, 4)
  const generateDraft = (created: Task) => {
    if (!baseUrl) return Promise.reject(new Error('API 未配置'))
    if (!['direction_selected', 'plan_confirmed'].includes(created.state))
      return Promise.reject(new Error('请先选择创意方向并确认制作方案'))
    return (
      created.state === 'plan_confirmed'
        ? Promise.resolve(created)
        : confirmTaskPlan(baseUrl, created.id, created.version)
    ).then((confirmed) =>
      generateContent(baseUrl, confirmed.id).then((draft) => ({
        task: confirmed,
        draft,
      })),
    )
  }
  useEffect(() => {
    if (!baseUrl || !targetProductId || !target) {
      setLoading(false)
      if (baseUrl) setError('请先从商品列表选择一个真实商品，再创建营销任务。')
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    setOperation(target.taskId ? '恢复原任务…' : '读取商品事实…')
    setTaskCreationAttempted(false)
    setTask(null)
    setProduct(null)
    setRemoteDirections(null)
    setDirectionsError('')
    setApproved(false)
    setContent(null)
    setContentVersions([])
    setFindings([])
    setReviewCategories([])
    setReviewStatus('idle')
    setReviewError('')
    setReviewTab('findings')
    setFeedback([])
    setFeedbackError('')
    setTimeline([])
    setTimelineError('')
    setUnderstanding(null)
    setQuestionAnswers({})
    setConversationReplies([])
    setSelectedCandidateId('')
    onContext(null)
    const restore = async () => {
      const targetIdentityError = validateTargetStoreIdentity(target)
      if (targetIdentityError) throw new Error(targetIdentityError)
      const selectedProduct = assertProductTargetIdentity(
        target.resolvedProduct ??
          (await fetchProduct(baseUrl, targetProductId)),
        {
          productId: target.productId,
          platform: target.platform,
          accountId: target.accountId,
          storeName: target.storeName,
        },
      )
      const productIdentityError = validateProductStoreIdentity(
        target,
        selectedProduct,
      )
      if (productIdentityError) throw new Error(productIdentityError)
      if (!cancelled) setProduct(selectedProduct)
      const current = target.taskId
        ? (target.resolvedTask ?? (await fetchTask(baseUrl, target.taskId)))
        : null
      if (!current) {
        setRequestText(`为「${targetTitle}」准备商品详情页营销内容`)
        // Product-first entry already has a safe, editable request. Hand the
        // next action to the composer so the merchant can type or press Enter
        // without hunting for the input after the context finishes loading.
        window.requestAnimationFrame(() => requestInputRef.current?.focus())
        return null
      }
      const taskIdentityError = validateTaskStoreIdentity(target, current)
      if (taskIdentityError) throw new Error(taskIdentityError)
      return current
    }
    restore()
      .then(async (current) => {
        if (cancelled) return null
        if (!current) return null
        if (!target.taskId) onTaskResolved(current.id)
        setTask(current)
        // Carry the server's original request into the conversation. For a
        // product-first entry, seed an honest, editable intent instead of
        // presenting an empty prompt that makes the merchant repeat context.
        setRequestText(
          current.requestText?.trim() ||
            `为「${targetTitle}」准备商品详情页营销内容`,
        )
        setApproved(
          ['approved', 'publish_prepared', 'publishing', 'delivered'].includes(
            current.state,
          ),
        )
        setDirection(
          Math.max(
            0,
            directions.findIndex(
              (item) => item.id === current.selectedDirectionId,
            ),
          ),
        )
        if (current.missingQuestions?.length)
          setUnderstanding({
            requestText: current.requestText ?? '',
            platformCandidates: [current.platform],
            productCandidates: [],
            extracted: {},
            questions: current.missingQuestions,
            executionPlan: {
              mode: 'single_task',
              canCreate: true,
              reason: '当前任务已绑定单一平台商品',
              childTasks: [
                {
                  platform: current.platform,
                  candidateProductIds: [current.productId],
                  bindingState: 'ready',
                },
              ],
            },
          })
        if (!target.taskId) return null
        const [versions, feedbackResult, timelineResult] = await Promise.all([
          fetchContentVersions(baseUrl, current.id),
          fetchTaskFeedback(baseUrl, current.id)
            .then((value) => ({ ok: true as const, value }))
            .catch((cause) => ({
              ok: false as const,
              error: describeApiError(cause),
            })),
          fetchTaskTimeline(baseUrl, current.id)
            .then((value) => ({ ok: true as const, value }))
            .catch((cause) => ({
              ok: false as const,
              error: describeApiError(cause),
            })),
        ])
        if (cancelled) return null
        if (feedbackResult.ok) {
          setFeedback(feedbackResult.value)
          setFeedbackError('')
        } else setFeedbackError(feedbackResult.error)
        if (timelineResult.ok) {
          setTimeline(
            timelineResult.value.map((event) => ({
              ...event,
              event_type: timelineEventLabel(event.event_type),
            })),
          )
          setConversationReplies(
            restoreConversationReplies(timelineResult.value),
          )
          setTimelineError('')
        } else setTimelineError(timelineResult.error)
        setContentVersions(
          versions.slice().sort((left, right) => right.version - left.version),
        )
        const restored =
          versions
            .slice()
            .sort((left, right) => right.version - left.version)[0] ?? null
        if (!restored) return null
        setContent(restored)
        onContext({ task: current, version: restored })
        setReviewStatus('loading')
        setReviewError('')
        try {
          const result = await reviewContent(baseUrl, restored.id)
          if (!cancelled) {
            setReviewStatus('succeeded')
            setFindings(result.findings)
            setReviewCategories(result.categories)
          }
          return null
        } catch (cause) {
          if (!cancelled) {
            setReviewStatus('failed')
            setReviewError(describeApiError(cause))
            setApproved(false)
          }
          return null
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(describeApiError(cause))
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setOperation('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [baseUrl, targetProductId, targetPlatform, target])
  useEffect(() => {
    const requestId = ++taskDirectionsRequestId.current
    if (!baseUrl || !task) {
      setRemoteDirections(null)
      setDirectionsError('')
      return
    }
    setRemoteDirections(null)
    setDirectionsError('')
    requestApi<TaskDirectionEvidence[]>(
      baseUrl,
      `/v1/tasks/${encodeURIComponent(task.id)}/directions`,
    )
      .then((next) => {
        if (requestId === taskDirectionsRequestId.current)
          setRemoteDirections(next)
      })
      .catch((cause) => {
        if (requestId === taskDirectionsRequestId.current)
          setDirectionsError(describeApiError(cause))
      })
  }, [baseUrl, task?.id, task?.version, directionsReloadKey])
  useEffect(() => {
    // The initial focus attempt can happen while the product context is still
    // loading and the composer is disabled. Retry once the new-task surface is
    // interactive, but never steal focus from an existing task or a question.
    if (!baseUrl || loading || target?.taskId || task || understanding || error)
      return
    window.requestAnimationFrame(() => requestInputRef.current?.focus())
  }, [baseUrl, loading, target?.taskId, task, understanding, error])
  useEffect(() => {
    if (!task?.selectedDirectionId || !directions.length) return
    const selectedIndex = directions.findIndex(
      (item) => item.id === task.selectedDirectionId,
    )
    if (selectedIndex >= 0) setDirection(selectedIndex)
  }, [task?.selectedDirectionId, directions])
  const loadTaskList = () => {
    const requestId = ++taskListRequestId.current
    if (!baseUrl || target) {
      setTaskListLoading(false)
      return
    }
    setTaskListLoading(true)
    setTaskListError('')
    setTaskList(null)
    fetchTaskPage(baseUrl, { limit: 12, offset: taskPage * 12 })
      .then((result) => {
        if (requestId === taskListRequestId.current) {
          setTaskList(result.items)
          setTaskTotal(result.total)
        }
      })
      .catch((cause) => {
        if (requestId === taskListRequestId.current)
          setTaskListError(describeApiError(cause))
      })
      .finally(() => {
        if (requestId === taskListRequestId.current) setTaskListLoading(false)
      })
  }
  const loadTaskProducts = () => {
    const requestId = ++taskProductsRequestId.current
    if (!baseUrl || target || taskList === null) {
      setTaskProductsLoading(false)
      return
    }
    setTaskProductsLoading(true)
    setTaskProductsError('')
    setTaskProducts([])
    Promise.all(
      [...new Set(taskList.map((item) => item.productId))].map((productId) =>
        fetchProduct(baseUrl, productId),
      ),
    )
      .then((products) => {
        if (requestId === taskProductsRequestId.current)
          setTaskProducts(products)
      })
      .catch((cause) => {
        if (requestId === taskProductsRequestId.current)
          setTaskProductsError(describeApiError(cause))
      })
      .finally(() => {
        if (requestId === taskProductsRequestId.current)
          setTaskProductsLoading(false)
      })
  }
  useEffect(() => {
    loadTaskList()
  }, [baseUrl, target, taskPage])
  useEffect(() => {
    loadTaskProducts()
  }, [baseUrl, target, taskList])
  const chooseDirection = (index: number, id: string) => {
    setDirection(index)
    if (!baseUrl || !task) return
    setOperation('方向保存中…')
    setError('')
    selectDirection(baseUrl, task.id, id)
      .then(setTask)
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const regenerate = () => {
    if (!baseUrl || !task || content) return
    setApproved(false)
    setOperation('生成内容中…')
    setError('')
    setReviewStatus('loading')
    setReviewError('')
    generateDraft(task)
      .then(({ task: confirmed, draft }) => {
        setTask(confirmed)
        setContent(draft)
        setContentVersions((current) => [
          draft,
          ...current.filter((item) => item.id !== draft.id),
        ])
        setVersion('v4')
        setReviewTab('findings')
        onContext({ task: confirmed, version: draft })
        return reviewContent(baseUrl, draft.id)
          .then((result) => {
            setFindings(result.findings)
            setReviewCategories(result.categories)
            setReviewStatus('succeeded')
          })
          .catch((cause) => {
            setReviewStatus('failed')
            setReviewError(describeApiError(cause))
            setApproved(false)
          })
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const showDiff = () => {
    if (!baseUrl || !content) {
      setVersion('diff')
      return
    }
    setOperation('读取版本差异…')
    fetchContentVersions(baseUrl, content.taskId)
      .then((versions) =>
        versions.find((candidate) => candidate.version === content.version - 1),
      )
      .then((previous) =>
        diffContentVersions(baseUrl, content.id, previous?.id),
      )
      .then((result) => {
        setDiffChanges(result?.changes ?? [])
        setVersion('diff')
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const viewVersion = (item: ContentVersion) => {
    setContent(item)
    setVersion('v4')
    setReviewTab('findings')
    if (!baseUrl) return
    setOperation('读取版本检查…')
    setError('')
    setReviewStatus('loading')
    setReviewError('')
    setFindings([])
    setReviewCategories([])
    setApproved(false)
    reviewContent(baseUrl, item.id)
      .then((result) => {
        setFindings(result.findings)
        setReviewCategories(result.categories)
        setReviewStatus('succeeded')
        if (task) onContext({ task, version: item })
      })
      .catch((cause) => {
        setReviewStatus('failed')
        setReviewError(describeApiError(cause))
        setError(describeApiError(cause))
      })
      .finally(() => setOperation(''))
  }
  const approve = (checked: boolean) => {
    if (reviewStatus !== 'succeeded') return
    if (!checked || !baseUrl || !task || !content) {
      setApproved(checked)
      return
    }
    setOperation('批准中…')
    setError('')
    approveContent(baseUrl, task.id, content.id)
      .then((result) => {
        setTask(result.task)
        setContent(result.version)
        setContentVersions((current) => [
          result.version,
          ...current.filter((item) => item.id !== result.version.id),
        ])
        setApproved(true)
        setFindings([])
        setReviewTab('findings')
        onContext({ task: result.task, version: result.version })
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const sendFeedback = (rating: FeedbackRating) => {
    setFeedbackRating(rating)
    if (!baseUrl || !task) return
    setOperation('反馈提交中…')
    setError('')
    submitTaskFeedback(baseUrl, task.id, {
      rating,
      ...(content?.id ? { content_version_id: content.id } : {}),
      ...(feedbackReason.trim() ? { reason: feedbackReason.trim() } : {}),
    })
      .then((item) => {
        setFeedback((current) => [item, ...current])
        setFeedbackError('')
        fetchTaskTimeline(baseUrl, task.id)
          .then((value) => {
            setTimeline(
              value.map((event) => ({
                ...event,
                event_type: timelineEventLabel(event.event_type),
              })),
            )
            setTimelineError('')
          })
          .catch((cause) => setTimelineError(describeApiError(cause)))
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const reloadFeedback = () => {
    if (!baseUrl || !task) return
    fetchTaskFeedback(baseUrl, task.id)
      .then((value) => {
        setFeedback(value)
        setFeedbackError('')
      })
      .catch((cause) => setFeedbackError(describeApiError(cause)))
  }
  const reloadTimeline = () => {
    if (!baseUrl || !task) return
    fetchTaskTimeline(baseUrl, task.id)
      .then((value) => {
        setTimeline(
          value.map((event) => ({
            ...event,
            event_type: timelineEventLabel(event.event_type),
          })),
        )
        setTimelineError('')
      })
      .catch((cause) => setTimelineError(describeApiError(cause)))
  }
  const decideFinding = (
    finding: ReviewFinding,
    status: 'acknowledged' | 'waived',
  ) => {
    if (!baseUrl || !content || finding.priority === 'P0') return
    if (status === 'waived') {
      setFindingDecision(finding)
      setFindingDecisionReason('')
      setFindingDecisionError('')
      return
    }
    setOperation('保存知悉状态中…')
    setError('')
    decideReviewFinding(baseUrl, content.id, {
      code: finding.code,
      field: finding.field,
      status,
      expected_revision: content.revision,
    })
      .then((result) => {
        setContent(result.version)
        setFindings(result.report.findings)
        setReviewCategories(result.report.categories)
        if (task) onContext({ task, version: result.version })
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const submitFindingWaiver = () => {
    const reason = findingDecisionReason.trim()
    if (!baseUrl || !content || !findingDecision || findingDecisionSubmitting)
      return
    if (reason.length < 4) {
      setFindingDecisionError('请填写至少 4 个字符的具体风险接受原因。')
      return
    }
    setFindingDecisionSubmitting(true)
    setFindingDecisionError('')
    decideReviewFinding(baseUrl, content.id, {
      code: findingDecision.code,
      field: findingDecision.field,
      status: 'waived',
      reason,
      expected_revision: content.revision,
    })
      .then((result) => {
        setContent(result.version)
        setFindings(result.report.findings)
        setReviewCategories(result.report.categories)
        if (task) onContext({ task, version: result.version })
        setFindingDecision(null)
        setFindingDecisionReason('')
        setFindingDecisionError('')
      })
      .catch((cause) => setFindingDecisionError(describeApiError(cause)))
      .finally(() => setFindingDecisionSubmitting(false))
  }
  const understand = () => {
    if (!baseUrl || !requestText.trim()) return
    setOperation('分析任务需求中…')
    setError('')
    understandTask(baseUrl, requestText.trim())
      .then((next) => {
        setUnderstanding(next)
        window.requestAnimationFrame(() => requestInputRef.current?.focus())
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const createTaskFromIntent = async () => {
    if (
      !baseUrl ||
      !target ||
      !understanding ||
      !requestText.trim() ||
      task ||
      operation
    )
      return
    setTaskCreationAttempted(true)
    setOperation('创建任务中…')
    setError('')
    const selected = understanding.productCandidates.find(
      (candidate) => candidate.id === selectedCandidateId,
    )
    const taskTarget =
      selected && selected.id !== target.productId
        ? fetchProduct(baseUrl, selected.id).then((candidateProduct) => ({
            ...target,
            productId: candidateProduct.id,
            title: candidateProduct.title,
            platform: candidateProduct.platform,
            remoteId: candidateProduct.remoteId,
            accountId: candidateProduct.accountId,
            storeName: candidateProduct.storeName,
          }))
        : Promise.resolve(target)
    taskTarget
      .then((resolvedTarget) =>
        createTaskOnce(baseUrl, resolvedTarget, requestText),
      )
      .then((current) => {
        const nextQuestions =
          current.missingQuestions ?? understanding.questions
        setTask(current)
        onTaskResolved(current.id)
        setUnderstanding((currentUnderstanding) =>
          currentUnderstanding
            ? { ...currentUnderstanding, questions: nextQuestions }
            : currentUnderstanding,
        )
        setRequestText(current.requestText?.trim() || requestText.trim())
        window.requestAnimationFrame(() =>
          (nextQuestions.length
            ? questionInputRef.current
            : requestInputRef.current
          )?.focus(),
        )
        setApproved(
          ['approved', 'publish_prepared', 'publishing', 'delivered'].includes(
            current.state,
          ),
        )
        onContext(null)
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const retryTaskCreation = () => {
    if (task) {
      reloadExistingTask()
      return
    }
    if (!baseUrl || !target || !requestText.trim() || operation) return
    setTaskCreationAttempted(true)
    setOperation('重新提交同一任务请求…')
    setError('')
    createTaskOnce(baseUrl, target, requestText)
      .then((current) => {
        setTask(current)
        onTaskResolved(current.id)
        setUnderstanding((currentUnderstanding) =>
          currentUnderstanding
            ? {
                ...currentUnderstanding,
                questions:
                  current.missingQuestions ?? currentUnderstanding.questions,
              }
            : currentUnderstanding,
        )
        onContext(null)
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const submitAnswer = (question: TaskQuestion) => {
    const answerValue = questionAnswers[question.id]?.trim() ?? ''
    if (!baseUrl || !task || (question.id !== 'confirm_facts' && !answerValue))
      return
    const value =
      question.id === 'confirm_facts'
        ? true
        : /^\d+$/u.test(answerValue) && question.id === 'output_count'
          ? Number(answerValue)
          : answerValue
    const conversationAnswer =
      question.id === 'confirm_facts' ? '已确认商品事实准确' : answerValue
    setOperation('保存补充信息中…')
    setError('')
    answerTask(baseUrl, task.id, { [question.id]: value }, task.version)
      .then((next) => {
        const nextQuestions = next.missingQuestions ?? []
        setTask(next)
        setUnderstanding((current) =>
          current ? { ...current, questions: nextQuestions } : current,
        )
        setQuestionAnswers((current) => ({ ...current, [question.id]: '' }))
        setConversationReplies((current) => [
          ...current,
          { question: question.prompt, answer: conversationAnswer },
        ])
        window.requestAnimationFrame(() =>
          (nextQuestions.length
            ? questionInputRef.current
            : requestInputRef.current
          )?.focus(),
        )
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  useEffect(() => {
    const handleQuestionSubmit = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || operation) return
      const input = event.target
      if (
        !(input instanceof HTMLInputElement) ||
        !input.matches('[aria-labelledby^="question-"]')
      )
        return
      const questionId = input
        .getAttribute('aria-labelledby')
        ?.replace(/^question-/u, '')
        .replace(/-label$/u, '')
      const question = understanding?.questions.find(
        (item) => item.id === questionId,
      )
      if (!question) return
      event.preventDefault()
      submitAnswer(question)
    }
    document.addEventListener('keydown', handleQuestionSubmit)
    return () => document.removeEventListener('keydown', handleQuestionSubmit)
  }, [operation, understanding, questionAnswers, task, baseUrl])
  const deferQuestion = (question: TaskQuestion) => {
    if (!baseUrl || !task || question.kind === 'blocking') return
    setOperation('暂存问题中…')
    setError('')
    answerTask(
      baseUrl,
      task.id,
      { defer_questions: [question.id] },
      task.version,
    )
      .then((next) => {
        setTask(next)
        setUnderstanding((current) =>
          current
            ? { ...current, questions: next.missingQuestions ?? [] }
            : current,
        )
        setConversationReplies((current) => [
          ...current,
          { question: question.prompt, answer: '已暂存，稍后补充' },
        ])
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const reloadExistingTask = () => {
    if (!baseUrl || !task || operation) return
    setOperation('重新读取任务状态…')
    setError('')
    fetchTask(baseUrl, task.id)
      .then((next) => {
        setTask(next)
        setApproved(
          ['approved', 'publish_prepared', 'publishing', 'delivered'].includes(
            next.state,
          ),
        )
        setUnderstanding(
          next.missingQuestions?.length
            ? {
                requestText: next.requestText ?? requestText,
                platformCandidates: [next.platform],
                productCandidates: [],
                extracted: {},
                questions: next.missingQuestions,
                executionPlan: {
                  mode: 'single_task',
                  canCreate: true,
                  reason: '当前任务已绑定单一平台商品',
                  childTasks: [
                    {
                      platform: next.platform,
                      candidateProductIds: [next.productId],
                      bindingState: 'ready',
                    },
                  ],
                },
              }
            : null,
        )
      })
      .catch((cause) => setError(describeApiError(cause)))
      .finally(() => setOperation(''))
  }
  const editTitle = async () => {
    if (!baseUrl || !content) return
    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      setTitleEditError('请输入新的首屏标题。')
      return
    }
    if (nextTitle === content.body.title) {
      setTitleEditError('标题没有变化，无需创建新版本。')
      return
    }
    setOperation('创建修改版本中…')
    setError('')
    try {
      const result = await modifyContentVersion(baseUrl, content.id, {
        changes: { title: nextTitle },
        locked_fields: ['price', 'stock', 'sku'],
        reason: 'merchant_studio_title_edit',
      })
      setTask(result.task)
      setContent(result.version)
      setContentVersions((current) => [
        result.version,
        ...current.filter((item) => item.id !== result.version.id),
      ])
      setApproved(false)
      setFindings([])
      setReviewTab('findings')
      onContext({ task: result.task, version: result.version })
      setTitleEditOpen(false)
    } catch (cause) {
      setTitleEditError(describeApiError(cause))
    } finally {
      setOperation('')
    }
  }
  const knownTaskStates = new Set([
    'draft',
    'ready_for_direction',
    'direction_selected',
    'plan_confirmed',
    'generating',
    'content_generated',
    'review_required',
    'changes_requested',
    'approved',
    'publish_prepared',
    'publishing',
    'delivered',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
  ])
  const taskStateLabel = (state: string) =>
    ({
      '': '待分析需求',
      draft: '待补充信息',
      ready_for_direction: '待选创意方向',
      direction_selected: '待确认制作方案',
      plan_confirmed: '待生成内容',
      generating: '内容生成中',
      content_generated: '待审核',
      review_required: '待审核',
      changes_requested: '待修改',
      approved: '已批准',
      publish_prepared: '待确认发布',
      publishing: '发布处理中',
      delivered: '已交付',
      failed_recoverable: '可重试',
      failed_terminal: '处理失败',
      canceled: '已取消',
    })[state] ?? '状态待确认'
  // A failed create response is not proof that no task was persisted. Keep this
  // state explicit so the UI never presents an empty, failed create as a saved task.
  const taskCreationUnconfirmed = Boolean(
    target && !target.taskId && !task && taskCreationAttempted && error,
  )
  const taskStateBlocked = Boolean(task && !knownTaskStates.has(task.state))
  // Keep the conversation mounted while a recoverable request error is shown.
  // The recovery card owns the next action; the thread remains the user's
  // source of context instead of disappearing on failure.
  const taskContextBlocked = taskStateBlocked
  useEffect(() => {
    if (taskStateBlocked && !error)
      setError('任务状态暂时无法确认，已暂停当前操作。请重新读取任务状态。')
  }, [taskStateBlocked, error])
  const taskPageSize = 12
  const taskPageCount = Math.max(1, Math.ceil(taskTotal / taskPageSize))
  const visibleTasks = useMemo(
    () => groupTasksForRecovery(taskList ?? []),
    [taskList],
  )
  const imageJobId = new URLSearchParams(window.location.search).get('image_job')?.trim()
  useEffect(() => {
    if (!timelineOpen) return
    timelineCloseRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTimelineOpen(false)
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        timelineModalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.requestAnimationFrame(() => timelineTriggerRef.current?.focus())
    }
  }, [timelineOpen])
  if (!target)
    return (
      <div className="page-stack">
        {imageJobId && <ImageGenerationJobPanel baseUrl={baseUrl} jobId={imageJobId} />}
        {!imageJobId && <ImageGenerationJobDiscovery baseUrl={baseUrl} />}
        <section className="page-intro">
          <div>
            <span className="section-kicker">TASK QUEUE</span>
            <h2>营销任务</h2>
            <p>从这里恢复已有任务；只有从商品页点击“创建任务”才会新建任务。</p>
          </div>
          <StatusChip tone="blue">
            {taskListLoading
              ? '读取中…'
              : taskListError
                ? '读取失败'
                : `${taskTotal} 个任务`}
          </StatusChip>
        </section>
        <CampaignLifecyclePanel baseUrl={baseUrl} />
        {taskListLoading && <LoadingState label="正在读取营销任务…" />}
        {taskListError && !taskListLoading && (
          <ErrorNotice message={taskListError} onRetry={loadTaskList} />
        )}
        {taskList !== null && taskProductsLoading && (
          <div className="info-notice" role="status">
            <RefreshCw className="spin" size={16} />
            任务列表已读取，正在补充当页商品与店铺身份；恢复操作暂时不可用。
          </div>
        )}
        {taskList !== null && taskProductsError && !taskProductsLoading && (
          <ErrorNotice
            message={`当页商品与店铺身份读取失败：${taskProductsError}。任务列表仍可浏览，恢复操作已暂停。`}
            onRetry={loadTaskProducts}
          />
        )}
        {!baseUrl && (
          <div className="info-notice">
            <CircleHelp size={16} />
            配置 API 后可读取真实任务列表。
          </div>
        )}
        {!taskListLoading && !taskListError && Boolean(taskList?.length) && (
          <section className="panel task-list-panel">
            {visibleTasks.map(({ task: item, groupLabel, actionLabel }) => {
              const itemProduct = taskProducts.find(
                (candidate) => candidate.id === item.productId,
              )
              const identityTarget = {
                accountId: item.accountId,
                storeName: itemProduct?.storeName,
              }
              const identityError = taskProductsLoading
                ? '商品与店铺身份正在读取，恢复任务暂不可用。'
                : taskProductsError
                  ? '商品与店铺身份读取失败，恢复操作暂不可用。请先重试身份读取。'
                  : itemProduct
                    ? (validateProductStoreIdentity(
                        identityTarget,
                        itemProduct,
                      ) ?? validateTaskStoreIdentity(identityTarget, item))
                    : '商品及店铺信息尚未恢复，已阻止恢复任务。'
              const label = item.missingQuestions?.length
                ? '待补充信息'
                : taskStateLabel(item.state)
              return (
                <div className="task-list-row" key={item.id}>
                  <div>
                    <b>
                      {itemProduct?.title ?? '营销任务'} ·{' '}
                      {platformNames[item.platform]} ·{' '}
                      {itemProduct?.storeName ?? '店铺身份待恢复'}
                    </b>
                    <span>
                      {groupLabel} · {actionLabel} ·{' '}
                      {item.accountId ? '店铺账号已确认 · ' : ''}
                      {new Date(item.createdAt).toLocaleString('zh-CN', {
                        hour12: false,
                      })}{' '}
                      · 内容版本 v{item.version}
                    </span>
                  </div>
                  <StatusChip
                    tone={
                      identityError ||
                      ['failed_recoverable', 'failed_terminal'].includes(
                        item.state,
                      ) ||
                      item.missingQuestions?.length
                        ? 'amber'
                        : ['approved', 'delivered'].includes(item.state)
                          ? 'green'
                          : 'blue'
                    }
                  >
                    {taskProductsLoading
                      ? '身份读取中'
                      : taskProductsError
                        ? '身份读取失败'
                        : identityError
                          ? '店铺身份异常'
                          : label}
                  </StatusChip>
                  <button
                    className="text-button"
                    onClick={() =>
                      itemProduct &&
                      onSelectTarget({
                        productId: item.productId,
                        platform: item.platform,
                        title: itemProduct.title,
                        accountId: item.accountId,
                        storeName: itemProduct.storeName,
                        taskId: item.id,
                      })
                    }
                    disabled={Boolean(identityError)}
                    title={identityError ?? undefined}
                  >
                    {actionLabel} <ArrowRight size={14} />
                  </button>
                </div>
              )
            })}
            <div className="task-list-pagination">
              <span>
                第 {taskPage + 1} / {taskPageCount} 页
              </span>
              <div>
                <button
                  onClick={() => setTaskPage((page) => Math.max(0, page - 1))}
                  disabled={taskPage === 0 || taskListLoading}
                >
                  上一页
                </button>
                <button
                  onClick={() =>
                    setTaskPage((page) => Math.min(taskPageCount - 1, page + 1))
                  }
                  disabled={taskPage >= taskPageCount - 1 || taskListLoading}
                >
                  下一页
                </button>
              </div>
            </div>
          </section>
        )}
        {!taskListLoading &&
          !taskListError &&
          taskList !== null &&
          taskTotal === 0 && (
            <div className="empty-state">
              <Sparkles size={22} />
              <b>暂无营销任务</b>
              <span>从商品与资产选择商品即可创建任务。</span>
            </div>
          )}
      </div>
    )
  return (
    <div className="task-shell">
      {timelineOpen && (
        <div className="modal-layer" role="presentation">
          <div
            className="modal timeline-modal"
            ref={timelineModalRef}
            role="dialog"
            aria-modal="true"
            aria-label="任务历史"
          >
            <div className="modal-head">
              <div className="modal-icon">
                <History size={18} />
              </div>
              <div>
                <span className="section-kicker">AUDIT TRAIL</span>
                <h2>任务历史</h2>
              </div>
              <button
                className="icon-button"
                ref={timelineCloseRef}
                onClick={() => setTimelineOpen(false)}
                aria-label="关闭任务历史"
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body timeline-list">
              {timelineError && (
                <ErrorNotice
                  message={`任务历史读取失败：${timelineError}。已保留上次成功记录。`}
                  onRetry={reloadTimeline}
                />
              )}
              {timeline.length
                ? timeline
                    .slice()
                    .reverse()
                    .map((event) => (
                      <div className="timeline-row" key={event.id}>
                        <span
                          className={`timeline-dot ${event.delivery === 'unknown' ? 'unknown' : event.delivery === 'delivered' ? 'delivered' : ''}`}
                        />
                        <div>
                          <b>{event.event_type}</b>
                          <span>
                            序列 {event.sequence} ·{' '}
                            {event.delivery === 'unknown'
                              ? '待对账'
                              : event.delivery === 'delivered'
                                ? '已记录'
                                : '处理中'}
                          </span>
                        </div>
                        <time>
                          {new Date(event.occurred_at).toLocaleString('zh-CN', {
                            hour12: false,
                          })}
                        </time>
                      </div>
                    ))
                : !timelineError && (
                    <div className="empty-state">
                      <History size={18} />
                      暂无可用历史事件
                    </div>
                  )}
            </div>
          </div>
        </div>
      )}
      {findingDecision && (
        <div className="modal-layer" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finding-waiver-title"
          >
            <div className="modal-head">
              <div className="modal-icon">
                <ShieldCheck size={18} />
              </div>
              <div>
                <span className="section-kicker">REVIEW DECISION</span>
                <h2 id="finding-waiver-title">带理由接受审核建议</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setFindingDecision(null)}
                aria-label="关闭风险接受弹窗"
                disabled={findingDecisionSubmitting}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body finding-decision-form">
              <p>{findingDecision.message}</p>
              <label htmlFor="finding-waiver-reason">风险接受原因</label>
              <textarea
                id="finding-waiver-reason"
                autoFocus
                value={findingDecisionReason}
                onChange={(event) => {
                  setFindingDecisionReason(event.target.value)
                  if (findingDecisionError) setFindingDecisionError('')
                }}
                maxLength={2000}
                rows={5}
                disabled={findingDecisionSubmitting}
                aria-describedby="finding-waiver-help"
              />
              <small id="finding-waiver-help">
                至少 4 个字符；原因会进入审核记录，不会自动发布内容。
              </small>
              {findingDecisionError && (
                <ErrorNotice message={findingDecisionError} compact />
              )}
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setFindingDecision(null)}
                disabled={findingDecisionSubmitting}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={submitFindingWaiver}
                disabled={findingDecisionSubmitting}
              >
                {findingDecisionSubmitting ? '保存中…' : '确认接受'}
              </button>
            </div>
          </div>
        </div>
      )}
      {titleEditOpen && content && (
        <DialogFrame
          testId="title-edit-dialog"
          kicker="CONTENT REVISION"
          title="修改首屏标题"
          onClose={() => setTitleEditOpen(false)}
          busy={operation === '创建修改版本中…'}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setTitleEditOpen(false)}
                disabled={Boolean(operation)}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => void editTitle()}
                disabled={Boolean(operation)}
              >
                {operation || '创建新版本'}
              </button>
            </>
          }
        >
          <div className="dialog-form">
            <label htmlFor="content-title-edit">
              首屏标题
              <input
                id="content-title-edit"
                data-dialog-initial-focus
                value={titleDraft}
                onChange={(event) => {
                  setTitleDraft(event.target.value)
                  setTitleEditError('')
                }}
                maxLength={200}
              />
            </label>
            <small>只修改标题；价格、库存与 SKU 会继续锁定。</small>
            {titleEditError && <ErrorNotice message={titleEditError} compact />}
          </div>
        </DialogFrame>
      )}
      <div
        className="task-titlebar"
        inert={timelineOpen || Boolean(findingDecision)}
      >
        <div>
          <button className="back-link" onClick={onBack}>
            <ArrowRight size={16} />
            所有任务
          </button>
          <h2>
            {targetTitle} · {platformNames[targetPlatform]} ·{' '}
            {target.storeName ?? '店铺身份缺失'}
          </h2>
          <div className="task-meta">
            <StatusChip
              tone={
                taskCreationUnconfirmed ? 'amber' : approved ? 'green' : 'blue'
              }
            >
              {taskCreationUnconfirmed
                ? '创建失败 · 未确认落库'
                : approved
                  ? '已批准'
                  : loading
                    ? '准备中'
                    : taskStateLabel(task?.state ?? '')}
            </StatusChip>
            <span>{target.accountId ? '店铺账号已确认' : '店铺身份缺失'}</span>
            <span>
              {task ? `内容版本 v${content?.version ?? 0}` : '内容版本尚未创建'}
            </span>
            <span>
              {operation || (taskCreationUnconfirmed ? '未保存成功' : '已保存')}
            </span>
          </div>
        </div>
        <div className="button-row compact">
          {task && (
            <button
              className="secondary"
              ref={timelineTriggerRef}
              onClick={() => {
                reloadTimeline()
                setTimelineOpen(true)
              }}
            >
              <History size={16} />
              历史
            </button>
          )}
        </div>
      </div>
      {loading && <LoadingState label={operation || '正在创建任务…'} />}
      {taskCreationUnconfirmed ? (
        <section
          className="panel context-recovery-card"
          role="alert"
          aria-labelledby="task-create-recovery-title"
          data-testid="task-create-recovery"
        >
          <div className="panel-heading">
            <div>
              <span className="section-kicker">TASK CREATION RECOVERY</span>
              <h3 id="task-create-recovery-title">创建任务未确认</h3>
            </div>
            <span className="status-chip amber">需核对</span>
          </div>
          <p>
            服务端没有返回成功回执，当前没有把任务标记为已创建。任务是否已落库未知，请先查看任务列表；确认没有同一任务后，再使用同一幂等请求重试。
          </p>
          <div className="context-recovery-meta">
            <span>商品：{targetTitle}</span>
            <span>平台：{platformNames[targetPlatform]}</span>
            <span>店铺：{target.storeName ?? '店铺身份待确认'}</span>
          </div>
          <div className="button-row">
            <button className="primary" onClick={onBack}>
              查看任务列表
            </button>
            <button
              className="secondary"
              onClick={retryTaskCreation}
              disabled={Boolean(operation)}
            >
              使用同一请求重试
            </button>
          </div>
        </section>
      ) : (
        error && (
          <div inert={timelineOpen || Boolean(findingDecision)}>
            <ContextRecoveryCard
              message={error}
              productTitle={targetTitle}
              platform={platformNames[targetPlatform]}
              storeName={target.storeName}
              onBackToProducts={onBackToProducts}
              onBackToTasks={onBack}
              onReload={retryTaskCreation}
            />
          </div>
        )
      )}
      {!taskContextBlocked && (
        <>
          <section
            className="task-conversation"
            aria-label="任务对话进度"
            data-testid="task-conversation"
            aria-busy={loading || Boolean(operation)}
            inert={timelineOpen || Boolean(findingDecision) || Boolean(error)}
          >
            <div className="conversation-heading">
              <div className="conversation-agent">
                <span className="agent-avatar" aria-hidden="true">
                  <Sparkles size={16} />
                </span>
                <div>
                  <span className="section-kicker">MERCHANT COPILOT</span>
                  <h3>任务协作线程</h3>
                </div>
              </div>
              <div role="status" aria-live="polite" aria-atomic="true">
                <StatusChip
                  tone={
                    operation
                      ? 'blue'
                      : error
                        ? 'amber'
                        : approved
                          ? 'green'
                          : 'neutral'
                  }
                >
                  {operation ||
                    (taskCreationUnconfirmed
                      ? '创建未确认'
                      : approved
                        ? '已完成审核'
                        : task
                          ? `进行中 · ${taskStateLabel(task.state)}`
                          : baseUrl
                            ? '待分析需求'
                            : '离线演示')}
                </StatusChip>
              </div>
            </div>
            <div className="conversation-thread">
              <div className="conversation-message assistant">
                <span className="message-marker" aria-hidden="true">
                  <Sparkles size={13} />
                </span>
                <div>
                  <b>
                    {loading
                      ? '正在恢复任务上下文'
                      : taskCreationUnconfirmed
                        ? '创建结果需要核对'
                        : error
                          ? '任务需要人工处理'
                          : content
                            ? '内容结果已经准备好'
                            : '我会和你一起完成这项任务'}
                  </b>
                  <p>
                    {loading
                      ? '正在读取商品、店铺、规则与版本证据。完成后会把下一步放在这里。'
                      : taskCreationUnconfirmed
                        ? '服务端回执不完整，系统没有把任务当作成功；请先查看任务列表，避免重复创建。'
                        : error
                          ? '当前上下文没有被视为成功，下面提供可恢复入口。'
                          : content
                            ? '审核结果、版本与发布前确认都保留在当前任务中。'
                            : '先确认需求和事实，再生成、审核，最后由你确认发布。'}
                  </p>
                </div>
              </div>
              {requestText && (
                <div className="conversation-message user">
                  <div>
                    <span>你的任务请求</span>
                    <p>{requestText}</p>
                  </div>
                </div>
              )}
              {conversationReplies.map((reply, index) => (
                <div
                  className="conversation-message user"
                  data-testid={`conversation-reply-${index}`}
                  key={`${reply.question}-${index}`}
                >
                  <div>
                    <span>你的补充</span>
                    <p>
                      <b>{reply.question}</b>：{reply.answer}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {understanding && (
              <div
                className="conversation-message assistant conversation-status-note"
                data-testid="task-create-confirmation"
                aria-label="执行前确认状态"
              >
                <span className="message-marker" aria-hidden="true">
                  <CircleHelp size={13} />
                </span>
                <div data-testid="task-confirmation-card">
                  <b>
                    执行前确认 ·{' '}
                    {understanding.questions.length
                      ? '需要你的输入'
                      : '可以继续'}
                  </b>
                  <p>
                    {understanding.questions.length
                      ? `下一步：${understanding.questions[0]?.prompt ?? '补充当前任务所需信息'}。`
                      : '下一步：确认当前商品事实后开始生成。'}
                  </p>
                  {!task && (
                    <small>
                      {selectedCandidateId
                        ? `已选择：${understanding.productCandidates.find((candidate) => candidate.id === selectedCandidateId)?.title ?? '候选商品'}`
                        : '任务会保存这次请求，并继续显示服务端返回的问题。'}
                    </small>
                  )}
                </div>
                {!task && (
                  <button
                    className="primary conversation-next-action"
                    onClick={() => void createTaskFromIntent()}
                    disabled={
                      Boolean(operation) ||
                      !understanding.executionPlan.canCreate
                    }
                  >
                    {operation === '创建任务中…'
                      ? '创建中…'
                      : '确认需求并创建任务'}
                  </button>
                )}
              </div>
            )}
            {content && (
              <div
                className="conversation-message assistant conversation-status-note"
                data-testid="task-result-card"
                aria-label="内容结果状态"
              >
                <span className="message-marker" aria-hidden="true">
                  <CheckCircle2 size={13} />
                </span>
                <div>
                  <b>内容结果 · 版本 v{content.version}</b>
                  <p>
                    {approved
                      ? '已批准；下一步只需在发布确认中提交。'
                      : '已完成服务端检查；下一步请在下方审核区批准。'}
                  </p>
                </div>
              </div>
            )}
            {recentTimeline.length > 0 && (
              <div
                className="conversation-events"
                aria-label="服务端任务进展"
                aria-live="polite"
                role="list"
              >
                {recentTimeline.map((event) => (
                  <div
                    className="conversation-event"
                    key={event.id}
                    role="listitem"
                  >
                    <span
                      className={`event-dot ${event.delivery === 'unknown' ? 'unknown' : event.delivery === 'delivered' ? 'delivered' : ''}`}
                      aria-hidden="true"
                    />
                    <div>
                      <b>{event.event_type}</b>
                      <p>
                        {event.delivery === 'unknown'
                          ? '结果待对账，系统不会把它标记为成功。'
                          : event.delivery === 'delivered'
                            ? '服务端已记录此进展。'
                            : '服务端正在处理此进展。'}
                      </p>
                    </div>
                    <time>
                      {new Date(event.occurred_at).toLocaleString('zh-CN', {
                        hour12: false,
                      })}
                    </time>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section
            className="panel task-understanding-panel"
            inert={timelineOpen || Boolean(findingDecision) || Boolean(error)}
          >
            <div className="panel-heading">
              <div>
                <span className="section-kicker">TASK UNDERSTANDING</span>
                <h3>先确认需求与阻断问题</h3>
              </div>
              <StatusChip
                tone={understanding?.questions.length ? 'amber' : 'green'}
              >
                {understanding?.questions.length
                  ? `${understanding.questions.length} 项待补充`
                  : '可继续执行'}
              </StatusChip>
            </div>
            <form
              className="understanding-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (!task) understand()
              }}
            >
              <div className="composer-field">
                <textarea
                  ref={requestInputRef}
                  aria-label="描述你的营销任务"
                  aria-describedby="task-composer-help"
                  rows={4}
                  maxLength={2000}
                  value={requestText}
                  onChange={(event) => setRequestText(event.target.value)}
                  onKeyDown={(event) => {
                    if (!task && event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      understand()
                    }
                  }}
                  placeholder="例如：把这件商品同步到淘宝和拼多多，主推防晒卖点"
                  readOnly={Boolean(task)}
                  title={
                    task
                      ? '任务已创建；如需更换商品或平台，请返回商品列表重新选择'
                      : undefined
                  }
                />
                <small id="task-composer-help">
                  {task
                    ? '任务已创建；当前请求已锁定。请在下方回答待补充问题。'
                    : '按 Enter 分析需求，Shift+Enter 换行'}
                </small>
              </div>
              <button
                type="submit"
                className={understanding ? 'text-button' : 'secondary'}
                disabled={
                  !baseUrl ||
                  !requestText.trim() ||
                  Boolean(operation) ||
                  Boolean(task)
                }
              >
                {understanding ? '重新分析' : '分析需求'}
              </button>
            </form>
            {understanding && (
              <div className="understanding-result">
                <span>
                  识别平台：
                  {understanding.platformCandidates
                    .map((platform) => platformNames[platform])
                    .join('、') || '待确认'}{' '}
                  · 目标：{understanding.extracted.goal ?? '待补充'}
                </span>
                <div
                  data-testid="task-execution-plan"
                  className="task-execution-plan"
                >
                  <div>
                    <b>
                      {understanding.executionPlan.mode === 'split_by_platform'
                        ? `将拆成 ${understanding.executionPlan.childTasks.length} 个独立平台子任务`
                        : understanding.executionPlan.mode === 'single_task'
                          ? '单平台独立任务'
                          : '等待明确平台'}
                    </b>
                    <small>{understanding.executionPlan.reason}</small>
                  </div>
                  <div className="execution-child-grid">
                    {understanding.executionPlan.childTasks.map((child) => (
                      <article key={child.platform}>
                        <StatusChip
                          tone={
                            child.bindingState === 'ready' ? 'green' : 'amber'
                          }
                        >
                          {platformNames[child.platform]}
                        </StatusChip>
                        <b>
                          {child.bindingState === 'ready'
                            ? '商品已唯一绑定'
                            : child.bindingState === 'ambiguous'
                              ? `${child.candidateProductIds.length} 个候选，需选择`
                              : '缺少该平台商品'}
                        </b>
                        <small>
                          {child.bindingState === 'ready'
                            ? '商品事实已读取'
                            : '不会复用其他平台商品'}
                        </small>
                      </article>
                    ))}
                  </div>
                </div>
                {understanding.productCandidates.length > 0 && (
                  <div
                    className="understanding-candidates"
                    aria-label="商品候选"
                  >
                    <small>检测到多个候选时，请直接选择一个稳定商品：</small>
                    {understanding.productCandidates.map((candidate) => (
                      <article key={candidate.id}>
                        <button
                          data-testid={`task-product-candidate-${candidate.id}`}
                          className={`candidate-choice ${selectedCandidateId === candidate.id ? 'selected' : ''}`}
                          aria-pressed={selectedCandidateId === candidate.id}
                          onClick={() => {
                            setSelectedCandidateId(candidate.id)
                            setQuestionAnswers((current) => ({
                              ...current,
                              product_id: candidate.id,
                            }))
                          }}
                        >
                          <b>{candidate.title}</b>
                          <span>
                            {platformNames[candidate.platform]} · 商品事实已读取
                          </span>
                        </button>
                      </article>
                    ))}
                  </div>
                )}
                {understanding.questions.slice(0, 1).map((question) => (
                  <div className="question-row" key={question.id}>
                    <div>
                      <b id={`question-${question.id}-label`}>
                        {question.prompt}
                      </b>
                      <small>
                        {understanding.questions.length > 1
                          ? `当前第 1 项，共 ${understanding.questions.length} 项；先完成这一项`
                          : '当前唯一待处理问题'}
                      </small>
                      <small>
                        {question.kind === 'blocking'
                          ? '阻断项，完成前不能继续'
                          : question.kind === 'recommended'
                            ? '建议补充，可使用默认值'
                            : '可选信息'}
                      </small>
                      <small>为什么问：{question.why}</small>
                      {question.evidenceKind && (
                        <small>{taskQuestionEvidenceLabels[question.evidenceKind]}</small>
                      )}
                      <small>不回答：{question.ifSkipped}</small>
                      {!task && (
                        <small>
                          先点击下方“确认需求并创建任务”，创建任务后才能回答。
                        </small>
                      )}
                    </div>
                    <div className="question-answer">
                      {question.id === 'platform_product_bindings' ? (
                        <button className="primary" onClick={onBackToProducts}>
                          返回商品列表分别选择
                        </button>
                      ) : question.id === 'confirm_facts' ? (
                        <button
                          className="primary"
                          onClick={() => submitAnswer(question)}
                          disabled={Boolean(operation) || !task}
                        >
                          {task ? '确认商品事实准确' : '先创建任务再确认事实'}
                        </button>
                      ) : (
                        <>
                          <input
                            ref={questionInputRef}
                            aria-labelledby={`question-${question.id}-label`}
                            value={questionAnswers[question.id] ?? ''}
                            onChange={(event) =>
                              setQuestionAnswers((current) => ({
                                ...current,
                                [question.id]: event.target.value,
                              }))
                            }
                            placeholder={
                              task ? '请输入答案' : '请先确认需求并创建任务'
                            }
                            disabled={!task || Boolean(operation)}
                          />
                          <button
                            className="primary"
                            onClick={() => submitAnswer(question)}
                            disabled={
                              Boolean(operation) ||
                              !task ||
                              !questionAnswers[question.id]?.trim()
                            }
                          >
                            {task ? '回答并继续' : '先创建任务'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          {understanding?.questions[0] &&
            understanding.questions[0].kind !== 'blocking' && (
              <div className="question-defer-note" role="note">
                <span>
                  暂时没有这项信息？可以先跳过，之后仍能在任务中补充。
                </span>
                <button
                  className="text-button"
                  onClick={() => deferQuestion(understanding.questions[0])}
                  disabled={Boolean(operation)}
                >
                  稍后补充
                </button>
              </div>
            )}
          <div
            className="workflow-stepper"
            aria-label={`任务进度 · 服务端状态 ${task?.state ?? '尚未返回'}`}
            data-testid="task-workflow-stepper"
          >
            {workflowSteps
              .map((step, index) => (
                <div
                  key={step.label}
                  className={
                    step.status === 'pending' ? undefined : step.status
                  }
                  data-step-status={step.status}
                >
                  <span>
                    {step.status === 'complete' ? (
                      <Check size={13} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <b>{step.label}</b>
                </div>
              ))
              .flatMap((step, index) =>
                index < workflowSteps.length - 1
                  ? [step, <i key={`divider-${index}`} />]
                  : [step],
              )}
          </div>
          <div
            className="workspace-grid"
            inert={timelineOpen || Boolean(findingDecision) || Boolean(error)}
          >
            <aside
              className={`context-panel ${contextCollapsed ? 'collapsed' : ''}`}
            >
              <div className="context-head">
                <span className="section-kicker">SOURCE OF TRUTH</span>
                <h3>任务事实</h3>
                <button
                  className="icon-button"
                  onClick={() => setContextCollapsed((current) => !current)}
                  aria-expanded={!contextCollapsed}
                  aria-label={
                    contextCollapsed ? '展开事实面板' : '收起事实面板'
                  }
                >
                  <PanelLeftClose size={17} />
                </button>
              </div>
              <div className="context-product">
                <div className="product-visual">
                  <ShoppingBag size={32} />
                </div>
                <div>
                  <StatusChip tone={platformTone[targetPlatform]}>
                    {platformNames[targetPlatform]}
                  </StatusChip>
                  <b>{targetTitle}</b>
                  <span>
                    {target.storeName && target.accountId
                      ? storeIdentityLabel(target)
                      : '店铺身份缺失，已阻止继续操作'}
                  </span>
                  <span>
                    {target?.remoteId ? '平台商品已确认' : '等待平台商品确认'}
                  </span>
                </div>
              </div>
              <div className="context-section">
                <div className="subhead">
                  <b>关键事实</b>
                  <StatusChip
                    tone={product?.factsConfirmed ? 'green' : 'amber'}
                  >
                    {product?.factsConfirmed ? '已确认' : '待确认'}
                  </StatusChip>
                </div>
                {Object.entries(product?.attributes ?? {})
                  .slice(0, 6)
                  .map(([key, value]) => (
                    <div className="fact-row" key={key}>
                      <span>{key}</span>
                      <b>{value}</b>
                      <small>
                        <Link2 size={11} />
                        商品事实库
                      </small>
                    </div>
                  ))}
                {!Object.keys(product?.attributes ?? {}).length && (
                  <div className="empty-inline">尚未读取商品属性</div>
                )}
              </div>
              <div className="context-section" data-testid="task-rule-evidence">
                <div className="subhead">
                  <b>约束与规则</b>
                  <span>
                    {baseUrl
                      ? `${taskRuleVersionIds.length} 个服务端版本`
                      : '2 条 · 离线演示'}
                  </span>
                </div>
                {baseUrl ? (
                  taskRuleVersionIds.length ? (
                    taskRuleVersionIds.map((ruleVersionId) => (
                      <div className="constraint" key={ruleVersionId}>
                        <ShieldCheck size={16} />
                        <div>
                          <b>{ruleVersionId}</b>
                          <span>服务端内容版本规则证据</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div
                      className="empty-inline"
                      data-testid="task-rules-empty"
                    >
                      服务端当前任务尚未返回规则版本；未展示任何演示规则。
                    </div>
                  )
                ) : (
                  <>
                    <div className="constraint">
                      <ShieldCheck size={16} />
                      <div>
                        <b>演示规则：不得表述“100% 防晒”</b>
                        <span>离线演示规则包 · 不可用于真实发布</span>
                      </div>
                    </div>
                    <div className="constraint">
                      <PackageSearch size={16} />
                      <div>
                        <b>演示约束：不修改价格与库存</b>
                        <span>离线演示任务范围</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </aside>

            <section className="editor-panel" aria-label="内容编辑区">
              <section
                className="direction-section"
                aria-busy={directionsData.mode === 'loading'}
              >
                <div className="section-heading-inline">
                  <div>
                    <span className="section-kicker">CREATIVE DIRECTIONS</span>
                    <h3>
                      {directionsData.mode === 'offline_demo'
                        ? `${directions.length} 个离线演示方向`
                        : directionsData.mode === 'api_ready'
                          ? `${directions.length} 个服务端方向`
                          : '服务端创意方向'}
                    </h3>
                  </div>
                  <button
                    className="text-button"
                    onClick={regenerate}
                    disabled={
                      Boolean(operation) ||
                      !baseUrl ||
                      Boolean(content) ||
                      !task?.selectedDirectionId ||
                      !['direction_selected', 'plan_confirmed'].includes(
                        task.state,
                      )
                    }
                  >
                    <RefreshCw
                      size={14}
                      className={
                        operation === '生成内容中…' ? 'spin' : undefined
                      }
                    />
                    {operation === '生成内容中…'
                      ? '生成中…'
                      : content
                        ? '内容已生成'
                        : '确认制作方案并生成'}
                  </button>
                </div>
                {directionsData.mode === 'loading' && (
                  <LoadingState label="正在读取服务端创意方向…" />
                )}
                {directionsData.mode === 'api_error' && (
                  <ErrorNotice
                    message={`创意方向读取失败：${directionsError}`}
                    onRetry={() => setDirectionsReloadKey((key) => key + 1)}
                  />
                )}
                {directionsData.mode === 'api_empty' && (
                  <div
                    className="empty-state"
                    data-testid="task-directions-empty"
                  >
                    <Sparkles size={20} />
                    <b>服务端尚未生成创意方向</b>
                    <span>
                      当前未展示任何演示方向；请先完成服务端要求的任务步骤。
                    </span>
                  </div>
                )}
                {directions.length > 0 && (
                  <div className="direction-grid">
                    {directions.map((item, index) => (
                      <button
                        key={item.id}
                        className={`direction-card ${direction === index && task?.selectedDirectionId === item.id ? 'selected' : ''}`}
                        onClick={() => chooseDirection(index, item.id)}
                        aria-pressed={
                          direction === index &&
                          task?.selectedDirectionId === item.id
                        }
                        disabled={
                          Boolean(operation) ||
                          Boolean(content) ||
                          directionsData.mode === 'offline_demo'
                        }
                      >
                        <div>
                          <span className="direction-letter">{item.id}</span>
                          <StatusChip tone="neutral">
                            {item.structure}
                          </StatusChip>
                          {direction === index &&
                            task?.selectedDirectionId === item.id && (
                              <span className="selected-check">
                                <Check size={13} />
                              </span>
                            )}
                        </div>
                        <h4>{item.name}</h4>
                        <p>{item.coreIdea}</p>
                        <small>
                          适配依据 <b>{item.fitReason}</b>
                          {item.risk ? ` · 风险：${item.risk}` : ''}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
                {task?.selectedDirectionId && !content && (
                  <div className="plan-confirmation-note">
                    <ShieldCheck size={16} />
                    <span>
                      服务端已选择方向 {task.selectedDirectionId}
                      。确认制作方案后才会产生生成任务；价格、库存与 SKU
                      保持锁定。
                    </span>
                  </div>
                )}
              </section>
              <section className="content-document">
                <div className="document-toolbar">
                  <div>
                    <span className="section-kicker">CONTENT DRAFT</span>
                    <h3>详情页内容草稿</h3>
                  </div>
                  <div className="segmented">
                    <button
                      className={version === 'v4' ? 'active' : ''}
                      onClick={() => setVersion('v4')}
                    >
                      v{content?.version ?? 0} 当前版
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (content) {
                          setTitleDraft(content.body.title)
                          setTitleEditError('')
                          setTitleEditOpen(true)
                        }
                      }}
                      disabled={!content || Boolean(operation)}
                    >
                      局部修改
                    </button>
                    <button
                      className={version === 'diff' ? 'active' : ''}
                      onClick={showDiff}
                      disabled={!content || Boolean(operation)}
                    >
                      <ArrowLeftRight size={13} />
                      与上一版比较
                    </button>
                  </div>
                </div>
                <ProductDetailPreview
                  content={content}
                  title={targetTitle}
                  product={product}
                  demoMode={!baseUrl}
                />
                {version === 'v4' ? (
                  <div className="document-body">
                    <div className="doc-label">首屏标题</div>
                    <h4>{content?.body.title ?? '等待内容版本'}</h4>
                    <p>
                      {content
                        ? topLevelDraft.notice
                        : '选择商品并生成内容版本后，再按详情模块证据逐项审阅。'}
                    </p>
                    <div className="source-note" role="note" aria-label="顶层内容证据状态">
                      <Link2 size={13} aria-hidden="true" />
                      顶层 detail/sellingPoints 未作为已验证内容展示
                    </div>
                    <div className="doc-label">核心卖点</div>
                    <div className="detail-rule-note" role="note" aria-label="核心卖点恢复提示">
                      <AlertCircle size={14} aria-hidden="true" />
                      <span>{topLevelDraft.notice}</span>
                    </div>
                    {content?.body.brief && (
                      <div className="brief-card">
                        <div className="doc-label">静态素材 Brief</div>
                        <p>
                          <b>{content.body.brief.placement}</b> ·{' '}
                          {content.body.brief.targetDimensions}
                        </p>
                        <p>
                          {content.body.brief.headline}｜
                          {content.body.brief.subheadline}
                        </p>
                        <p>
                          核心卖点：{content.body.brief.coreSellingPoint} ·
                          CTA：{content.body.brief.cta}
                        </p>
                        <small>
                          安全区：{content.body.brief.safeArea} · 禁止修改：
                          {content.body.brief.protectedAreas.join('、')}
                        </small>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="diff-view">
                    {diffChanges.length ? (
                      diffChanges.map((change) => (
                        <div className="diff-line added" key={change.path}>
                          <span>+</span>
                          <p>
                            <b>{change.path}</b>：{String(change.after ?? '')}
                          </p>
                        </div>
                      ))
                    ) : (
                      <div className="diff-line">
                        <span>·</span>
                        <p>暂无服务端差异或没有上一版本</p>
                      </div>
                    )}
                    <div className="diff-summary">
                      <CheckCircle2 size={17} />
                      版本差异来自服务端内容版本 API
                    </div>
                  </div>
                )}
              </section>
            </section>

            <aside className="review-panel">
              <div className="review-score">
                <div
                  className="score-ring"
                  style={{
                    background: `conic-gradient(var(--green) 0 ${content && reviewStatus === 'succeeded' && !blockingFindings ? 100 : 0}%,#e3e8e4 ${content && reviewStatus === 'succeeded' && !blockingFindings ? 100 : 0}%)`,
                  }}
                >
                  <strong>{reviewScore}</strong>
                  <span>/100</span>
                </div>
                <div>
                  <span className="section-kicker">REVIEW SCORE</span>
                  <h3>
                    {!content
                      ? '等待内容版本'
                      : reviewStatus === 'loading'
                        ? '正在读取服务端检查'
                        : reviewStatus !== 'succeeded'
                          ? '审核结果待确认'
                          : blockingFindings
                            ? '存在阻断项'
                            : '可以进入人工确认'}
                  </h3>
                  <p>
                    {reviewStatus !== 'succeeded'
                      ? '服务端检查未完成，暂不允许批准或发布。'
                      : `${blockingFindings} 项阻断 · ${warningFindings} 项建议`}
                  </p>
                </div>
              </div>
              {reviewError && (
                <ErrorNotice
                  message={`审核结果读取失败：${reviewError}。已阻止批准和发布，请重新读取审核结果。`}
                  onRetry={() => {
                    if (!baseUrl || !content) return
                    setReviewStatus('loading')
                    setReviewError('')
                    reviewContent(baseUrl, content.id)
                      .then((result) => {
                        setFindings(result.findings)
                        setReviewCategories(result.categories)
                        setReviewStatus('succeeded')
                      })
                      .catch((cause) => {
                        setReviewStatus('failed')
                        setReviewError(describeApiError(cause))
                      })
                  }}
                  compact
                />
              )}
              <div className="review-category-list">
                {reviewCategories.map((category) => (
                  <div
                    className={`review-category ${category.status}`}
                    key={category.id}
                  >
                    <span>
                      {category.status === 'passed' ? (
                        <CheckCircle2 size={14} />
                      ) : category.status === 'blocking' ? (
                        <AlertCircle size={14} />
                      ) : (
                        <CircleHelp size={14} />
                      )}
                    </span>
                    <div>
                      <b>{category.name}</b>
                      <small>{category.summary}</small>
                    </div>
                  </div>
                ))}
              </div>
              <div
                className="review-tabs"
                role="tablist"
                aria-label="内容检查与版本记录"
              >
                <button
                  id="review-findings-tab"
                  role="tab"
                  aria-selected={reviewTab === 'findings'}
                  aria-controls="review-findings-panel"
                  tabIndex={reviewTab === 'findings' ? 0 : -1}
                  className={reviewTab === 'findings' ? 'active' : ''}
                  onKeyDown={(event) =>
                    handleTabKeyDown(
                      event,
                      ['findings', 'versions'] as const,
                      reviewTab,
                      setReviewTab,
                    )
                  }
                  onClick={() => setReviewTab('findings')}
                >
                  检查结果 <em>{findings.length}</em>
                </button>
                <button
                  id="review-versions-tab"
                  role="tab"
                  aria-selected={reviewTab === 'versions'}
                  aria-controls="review-versions-panel"
                  tabIndex={reviewTab === 'versions' ? 0 : -1}
                  className={reviewTab === 'versions' ? 'active' : ''}
                  onKeyDown={(event) =>
                    handleTabKeyDown(
                      event,
                      ['findings', 'versions'] as const,
                      reviewTab,
                      setReviewTab,
                    )
                  }
                  onClick={() => setReviewTab('versions')}
                >
                  版本记录 <em>{contentVersions.length}</em>
                </button>
              </div>
              {reviewTab === 'findings' ? (
                <div
                  className="finding-list"
                  id="review-findings-panel"
                  role="tabpanel"
                  aria-labelledby="review-findings-tab"
                  tabIndex={0}
                >
                  {findings.length ? (
                    findings.map((finding) => {
                      const evidenceLabel = reviewEvidenceLabel(finding)
                      return (
                        <article
                          className={`finding ${finding.severity === 'error' ? 'warning' : 'info'}`}
                          key={`${finding.code}-${finding.field}`}
                        >
                          <div>
                            <AlertCircle size={17} />
                            <b>
                              {finding.priority} ·{' '}
                              {finding.severity === 'error'
                                ? '阻断'
                                : finding.status === 'waived'
                                  ? '已接受'
                                  : finding.status === 'acknowledged'
                                    ? '已知悉'
                                    : '建议'}{' '}
                              · {reviewFieldLabel(finding.field)}
                            </b>
                          </div>
                          <p>{finding.message}</p>
                          {evidenceLabel && <small>{evidenceLabel}</small>}
                          <small>建议：{finding.repairSuggestion}</small>
                          {finding.decision && (
                            <small>处理记录：{finding.decision.reason}</small>
                          )}
                          {finding.severity === 'warning' &&
                            finding.status === 'open' && (
                              <div className="finding-actions">
                                <button
                                  onClick={() =>
                                    decideFinding(finding, 'acknowledged')
                                  }
                                  disabled={Boolean(operation)}
                                >
                                  标记已知悉
                                </button>
                                <button
                                  onClick={() =>
                                    decideFinding(finding, 'waived')
                                  }
                                  disabled={Boolean(operation)}
                                >
                                  带理由接受
                                </button>
                              </div>
                            )}
                        </article>
                      )
                    })
                  ) : (
                    <div className="empty-state">
                      <CheckCircle2 size={18} />
                      {content
                        ? '服务端检查通过，暂无发现项'
                        : '生成内容后显示检查结果'}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="version-list"
                  id="review-versions-panel"
                  role="tabpanel"
                  aria-labelledby="review-versions-tab"
                  tabIndex={0}
                >
                  {contentVersions.length ? (
                    contentVersions.map((item) => (
                      <article
                        className={`version-row ${item.id === content?.id ? 'current' : ''}`}
                        key={item.id}
                      >
                        <div>
                          <b>内容版本 v{item.version}</b>
                          <span>
                            {item.id === content?.id ? '当前版本' : '历史版本'}{' '}
                            · {item.state} · 引用事实{' '}
                            {item.factVersionIds.length} 条 · 规则{' '}
                            {item.ruleVersionIds.length} 条
                          </span>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => viewVersion(item)}
                        >
                          查看版本
                        </button>
                      </article>
                    ))
                  ) : (
                    <div className="empty-state">
                      <History size={18} />
                      当前任务暂无内容版本
                    </div>
                  )}
                </div>
              )}
              <div className="feedback-section">
                <div className="subhead">
                  <b>交付反馈</b>
                  <span>仅用于当前任务分析</span>
                </div>
                <p className="feedback-hint">
                  内容交付后告诉我们效果，不会自动修改全局规则。
                </p>
                {feedbackError && (
                  <ErrorNotice
                    message={`反馈记录读取失败：${feedbackError}。已保留上次成功记录。`}
                    onRetry={reloadFeedback}
                    compact
                  />
                )}
                <div className="feedback-actions">
                  <button
                    className={feedbackRating === 'liked' ? 'selected' : ''}
                    onClick={() => sendFeedback('liked')}
                    disabled={Boolean(operation) || !task || !content}
                  >
                    满意
                  </button>
                  <button
                    className={feedbackRating === 'neutral' ? 'selected' : ''}
                    onClick={() => sendFeedback('neutral')}
                    disabled={Boolean(operation) || !task || !content}
                  >
                    一般
                  </button>
                  <button
                    className={
                      feedbackRating === 'needs_improvement' ? 'selected' : ''
                    }
                    onClick={() => sendFeedback('needs_improvement')}
                    disabled={Boolean(operation) || !task || !content}
                  >
                    需改进
                  </button>
                </div>
                <input
                  className="feedback-input"
                  value={feedbackReason}
                  onChange={(event) => setFeedbackReason(event.target.value)}
                  placeholder="可选：补充原因"
                  maxLength={2000}
                  disabled={!content}
                />
                {feedback.length > 0 && (
                  <small className="feedback-count">
                    已记录 {feedback.length} 条任务反馈
                  </small>
                )}
              </div>
              <div className="approval-box">
                <label>
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(e) => approve(e.target.checked)}
                    disabled={
                      Boolean(operation) ||
                      loading ||
                      approved ||
                      !content ||
                      reviewStatus !== 'succeeded'
                    }
                  />
                  <span>
                    <b>我已核对事实、规则和最终内容</b>
                    <small>
                      {reviewStatus === 'succeeded' && content
                        ? `批准后会锁定内容 v${content.version}；发布仍需二次确认。`
                        : '服务端检查完成后才可批准。'}
                    </small>
                  </span>
                </label>
                <button
                  className="primary wide"
                  disabled={
                    !approved ||
                    Boolean(operation) ||
                    !content ||
                    reviewStatus !== 'succeeded'
                  }
                  onClick={openPublish}
                >
                  {operation === '批准中…'
                    ? '批准中…'
                    : approved
                      ? '继续确认发布'
                      : '勾选后批准内容'}
                  <ArrowRight size={16} />
                </button>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

function PublishCenter({
  openPublish,
  openCorrection,
  baseUrl,
  canOpenPublish,
}: {
  openPublish: () => void
  openCorrection: (job: PublishJob) => void
  baseUrl?: string
  canOpenPublish: boolean
}) {
  const [jobs, setJobs] = useState<PublishJob[] | null>(null)
  const [initialError, setInitialError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [reloadKey, setReloadKey] = useState(0)
  const jobsSourceRef = useRef<string | undefined>(undefined)
  const lastSuccessfulJobsRef = useRef<PublishJob[]>([])
  useEffect(() => {
    if (!baseUrl) {
      jobsSourceRef.current = undefined
      lastSuccessfulJobsRef.current = []
      setLoading(false)
      setJobs(null)
      setInitialError('')
      setRefreshError('')
      return
    }
    let cancelled = false
    let inFlight = false
    const hasCachedJobs = jobsSourceRef.current === baseUrl && jobs !== null
    let hasLoadedJobs = hasCachedJobs
    // Keep the last successful list visible during both background refresh and
    // manual retry. A transient request must never create a false empty state.
    jobsSourceRef.current = baseUrl
    const load = (showLoading: boolean) => {
      if (inFlight) return
      inFlight = true
      if (showLoading && !hasLoadedJobs) setLoading(true)
      setInitialError('')
      setRefreshError('')
      fetchPublishJobs(baseUrl)
        .then((next) => {
          if (!cancelled) {
            hasLoadedJobs = true
            const safeJobs = next
              .slice()
              .sort(
                (left, right) =>
                  Number(right.state === 'rejected') -
                    Number(left.state === 'rejected') ||
                  Date.parse(right.createdAt) - Date.parse(left.createdAt),
              )
              .map((job, index) => ({
                ...job,
                id: `发布请求 ${index + 1}`,
                remoteState: undefined,
                rejection: job.rejection
                  ? {
                      ...job.rejection,
                      rawCode: '平台拒绝',
                      fields: job.rejection.fields.map((field) => ({
                        ...field,
                        rawCode: undefined,
                      })),
                    }
                  : undefined,
              }))
            lastSuccessfulJobsRef.current = safeJobs
            setJobs(safeJobs)
            setInitialError('')
            setRefreshError('')
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            const message = describeApiError(cause)
            if (hasLoadedJobs || lastSuccessfulJobsRef.current.length) {
              if (lastSuccessfulJobsRef.current.length)
                setJobs(lastSuccessfulJobsRef.current)
              setRefreshError(message)
            } else setInitialError(message)
          }
        })
        .finally(() => {
          inFlight = false
          if (!cancelled && showLoading) setLoading(false)
        })
    }
    load(true)
    const timer = window.setInterval(() => load(false), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [baseUrl, reloadKey])
  const statusLabel = (state: string) =>
    ({
      queued: '排队中',
      submitted: '平台已受理',
      reviewing: '平台审核中',
      published: '已生效',
      rejected: '平台驳回',
      unknown: '待对账',
      manual_attention: '需人工处理',
    })[state] ?? state
  const statusTone = (state: string) =>
    state === 'published'
      ? 'green'
      : ['rejected', 'unknown', 'manual_attention'].includes(state)
        ? 'amber'
        : 'blue'
  const listReady = !loading && jobs !== null
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="section-kicker">CONTROLLED WRITES</span>
          <h2>每一次线上变更都有确认和回执</h2>
          <p>“平台已受理”不等于“已生效”。未知状态先对账，不盲目重复提交。</p>
        </div>
        <button
          className="primary"
          onClick={openPublish}
          disabled={!baseUrl || !canOpenPublish}
        >
          <Rocket size={17} />
          进入已审核任务发布
        </button>
      </section>
      {initialError && !loading && (
        <ErrorNotice
          message={initialError}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      )}
      {refreshError && listReady && (
        <ErrorNotice
          message={`发布任务自动刷新失败：${refreshError}。已保留上次成功数据。`}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      )}
      {!baseUrl && (
        <div className="info-notice" role="status">
          <CircleHelp size={16} />
          离线演示不会伪造真实平台回执。
        </div>
      )}
      {baseUrl && !canOpenPublish && (
        <div className="info-notice" role="status">
          <CircleHelp size={16} />
          请先在商品与资产中选择商品并完成内容审核。
        </div>
      )}
      <section className="publish-board" aria-busy={loading}>
        <div className="panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">IN FLIGHT</span>
              <h3>进行中的发布</h3>
            </div>
            <StatusChip tone={refreshError ? 'amber' : 'blue'}>
              {loading
                ? '读取中…'
                : initialError
                  ? '读取失败'
                  : refreshError
                    ? `${jobs?.length ?? 0} 个任务 · 刷新失败`
                    : `${jobs?.length ?? 0} 个任务`}
            </StatusChip>
          </div>
          {loading && <LoadingState label="正在读取发布任务…" />}
          {listReady &&
            Boolean(jobs.length) &&
            jobs.map((job) => (
              <div
                className={`publish-job ${job.state === 'rejected' ? 'has-rejection' : ''}`}
                key={job.id}
              >
                <div
                  className={`platform-logo ${platformTone[job.platform] ?? 'blue'}`}
                >
                  {(platformNames[job.platform] ?? job.platform).slice(0, 1)}
                </div>
                <div>
                  <b>
                    {platformNames[job.platform] ?? job.platform} · 发布任务
                  </b>
                  <span>
                    提交记录已保留 ·{' '}
                    {new Date(job.createdAt).toLocaleString('zh-CN', {
                      hour12: false,
                    })}
                  </span>
                </div>
                <StatusChip tone={statusTone(job.state)}>
                  {job.state === 'published' ? (
                    <Check size={12} />
                  ) : job.state === 'rejected' ? (
                    <X size={12} />
                  ) : (
                    <Clock3 size={12} />
                  )}
                  {statusLabel(job.state)}
                </StatusChip>
                {job.state === 'rejected' && (
                  <div className="publish-rejection">
                    <div>
                      <b>
                        平台拒绝码：{job.rejection?.rawCode ?? '平台未返回代码'}
                      </b>
                      <p>
                        {job.rejection?.message ??
                          '平台未返回可读原因，请联系平台支持并提供发布任务时间。'}
                      </p>
                      {job.rejection?.fields.map((field) => (
                        <span key={`${field.path}-${field.rawCode ?? ''}`}>
                          需修改：{platformFieldLabel(field.path)} ·{' '}
                          {field.message}
                          {field.rawCode ? `（${field.rawCode}）` : ''}
                        </span>
                      ))}
                    </div>
                    <button
                      className="secondary correction-button"
                      onClick={() => openCorrection(job)}
                    >
                      定位并修正 <ArrowRight size={14} />
                    </button>
                    <small>
                      修正后会生成新版本，必须重新审核、批准并确认发布；系统不会自动重发。
                    </small>
                  </div>
                )}
              </div>
            ))}
          {listReady && jobs.length === 0 && (
            <div className="empty-state">
              <PackageSearch size={22} />
              <b>暂无真实发布任务</b>
              <span>完成内容审核后，发布任务会显示在这里。</span>
            </div>
          )}
        </div>
        <div className="panel receipt-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">RECEIPTS</span>
              <h3>最近回执</h3>
            </div>
          </div>
          {loading && <LoadingState label="正在读取平台回执…" />}
          {listReady &&
            Boolean(jobs.length) &&
            jobs.slice(0, 5).map((job) => (
              <div className="receipt-row" key={`receipt-${job.id}`}>
                <span
                  className={`receipt-icon ${job.state === 'rejected' ? 'fail' : ''}`}
                >
                  {job.state === 'rejected' ? (
                    <X size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                </span>
                <b>
                  {platformNames[job.platform] ?? job.platform} ·{' '}
                  {statusLabel(job.state)}
                </b>
                <span>
                  回执已保留 ·{' '}
                  {job.rejection?.rawCode ?? job.remoteState ?? '等待观测'}
                </span>
              </div>
            ))}
          {listReady && jobs.length === 0 && (
            <div className="empty-state">
              <span>暂无回执</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function Rules({ baseUrl, target }: { baseUrl?: string; target?: Target }) {
  const [rulePacks, setRulePacks] = useState<RulePack[] | null>(null)
  const [remoteCategories, setRemoteCategories] = useState<
    CatalogCategory[] | null
  >(null)
  const [rulesError, setRulesError] = useState('')
  const [categoriesError, setCategoriesError] = useState('')
  const [rulesReloadKey, setRulesReloadKey] = useState(0)
  const [categoriesReloadKey, setCategoriesReloadKey] = useState(0)
  const [tab, setTab] = useState<'rules' | 'categories'>('rules')
  const [query, setQuery] = useState('')
  const urlPlatform =
    typeof window === 'undefined'
      ? undefined
      : new URLSearchParams(window.location.search).get('platform')
  const ruleContext = resolveRuleContext(
    target ??
      (urlPlatform &&
      Object.prototype.hasOwnProperty.call(platformNames, urlPlatform)
        ? { platform: urlPlatform as PlatformId }
        : undefined),
  )
  const [platform, setPlatform] = useState<PlatformId | 'all'>(
    ruleContext.platform,
  )
  const [selectedCategory, setSelectedCategory] =
    useState<CatalogCategory | null>(null)
  useEffect(() => {
    setPlatform(ruleContext.platform)
  }, [ruleContext.platform])
  useEffect(() => {
    if (!baseUrl) {
      setRulePacks(null)
      setRulesError('')
      return
    }
    let cancelled = false
    setRulePacks(null)
    setRulesError('')
    fetchRulePacks(baseUrl, platform === 'all' ? undefined : platform)
      .then((next) => {
        if (!cancelled) setRulePacks(next)
      })
      .catch((cause) => {
        if (!cancelled) setRulesError(describeApiError(cause))
      })
    return () => {
      cancelled = true
    }
  }, [baseUrl, platform, rulesReloadKey])
  useEffect(() => {
    if (!baseUrl) {
      setRemoteCategories(null)
      setCategoriesError('')
      return
    }
    let cancelled = false
    setRemoteCategories(null)
    setCategoriesError('')
    setSelectedCategory(null)
    fetchCatalogCategories(baseUrl)
      .then((next) => {
        if (!cancelled) setRemoteCategories(next)
      })
      .catch((cause) => {
        if (!cancelled) setCategoriesError(describeApiError(cause))
      })
    return () => {
      cancelled = true
    }
  }, [baseUrl, categoriesReloadKey])
  const fallbackRows: RulePack[] = [
    ['中国电商广告表达', 'cn-commerce-1.0.0', '全平台', '今天'],
    ['服装鞋包事实完整性', 'apparel-1.0.0', '全平台', '2 天前'],
    ['淘宝/天猫字段映射', 'tmall-apparel-1.0.0', '淘宝/天猫', '5 天前'],
    ['京东商品写入策略', 'jd-apparel-write-1.0.0', '京东', '7 天前'],
  ].map((row, index) => ({
    id: String(index),
    name: row[0],
    version: row[1],
    scope: row[2],
    status: 'active',
    updatedAt: row[3],
  }))
  const fallbackCategories: CatalogCategory[] = [
    {
      name: '服装 / 防晒外套',
      code: '1312',
      fields: ['材质、成分、重量、尺码、颜色、功能依据'],
      platforms: [
        'jd',
        'taobao',
        'tmall',
        'pinduoduo',
        'xiaohongshu',
        'douyin',
      ],
      status: 'active',
      updatedAt: '今天',
    },
    {
      name: '鞋靴 / 户外鞋',
      code: '1408',
      fields: ['鞋面材质、闭合方式、适用场景、尺码'],
      platforms: ['jd', 'taobao', 'pinduoduo'],
      status: 'active',
      updatedAt: '昨天',
    },
    {
      name: '运动 / 速干裤装',
      code: '1503',
      fields: ['面料、版型、弹性、洗护、尺码'],
      platforms: ['taobao', 'tmall'],
      status: 'active',
      updatedAt: '3 天前',
    },
  ]
  const rulesData = resolveLibraryData({
    baseUrl,
    remote: rulePacks,
    error: rulesError,
    fixtures: fallbackRows,
  })
  const categoriesData = resolveLibraryData({
    baseUrl,
    remote: remoteCategories,
    error: categoriesError,
    fixtures: fallbackCategories,
  })
  const rows = rulesData.items
  const categories = categoriesData.items
  const ruleSource = `${({ offline_demo: '离线演示规则', loading: '正在读取 API 规则', api_error: 'API 规则读取失败', api_empty: 'API 已连接 · 暂无规则数据', api_ready: '已连接 API · 管理员发布数据' } as const)[rulesData.mode]} · 当前作用域：${platform === 'all' ? '全部平台' : platformNames[platform]}${target ? ` · ${target.storeName && target.accountId ? `${target.storeName} · 店铺身份已确认` : '店铺身份待确认'}` : ''}`
  const categorySource = (
    {
      offline_demo: '离线演示类目',
      loading: '正在读取 API 类目',
      api_error: 'API 类目读取失败',
      api_empty: 'API 已连接 · 暂无类目数据',
      api_ready: '已连接 API · 管理员发布数据',
    } as const
  )[categoriesData.mode]
  const platformRows =
    platform === 'all'
      ? rows
      : rows.filter(
          (row) =>
            row.scope.includes('全平台') ||
            row.scope.includes(platformNames[platform]),
        )
  const filteredRules = platformRows.filter((row) =>
    `${row.name}${row.scope}${row.version}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  )
  const filteredCategories = categories.filter((row) =>
    `${row.name}${row.code}${row.fields.join('')}`.includes(query),
  )
  const attributeTemplateCount = new Set(
    categories.flatMap((category) => category.fields),
  ).size
  const mappingStatus = (
    {
      offline_demo: '离线演示',
      loading: '读取中',
      api_error: '读取失败',
      api_empty: '暂无数据',
      api_ready: '实时读取',
    } as const
  )[categoriesData.mode]
  const ruleMetric = ['loading', 'api_error'].includes(rulesData.mode)
    ? '—'
    : String(rows.filter((row) => row.status === 'active').length)
  const categoryMetric = ['loading', 'api_error'].includes(categoriesData.mode)
    ? '—'
    : String(categories.length)
  const attributeMetric = ['loading', 'api_error'].includes(categoriesData.mode)
    ? '—'
    : String(attributeTemplateCount)
  const rulesContent = (
    <>
      {rulesData.mode === 'loading' ? (
        <LoadingState label="正在读取规则库…" />
      ) : rulesData.mode === 'api_error' ? (
        <ErrorNotice
          message={`规则库读取失败：${rulesError}`}
          onRetry={() => setRulesReloadKey((key) => key + 1)}
        />
      ) : rulesData.mode === 'api_empty' ? (
        <div className="empty-state" data-testid="rules-api-empty">
          <ShieldCheck size={20} />
          <b>API 暂无生效规则包</b>
          <span>服务已成功返回空数据；未混入任何演示规则。</span>
        </div>
      ) : filteredRules.length ? (
        filteredRules.map((row) => (
          <div className="rule-row" key={row.id}>
            <div className="rule-symbol">
              <ShieldCheck size={17} />
            </div>
            <div>
              <b>{row.name}</b>
              <span>
                {row.version} · 修订 {row.revision ?? 1}
              </span>
            </div>
            <StatusChip tone="neutral">{row.scope}</StatusChip>
            <span>{row.status === 'active' ? '生效中' : row.status}</span>
            <span className="rule-audit-meta">
              {row.source?.reference ??
                (rulesData.mode === 'offline_demo'
                  ? '演示数据'
                  : 'API 规则包')}{' '}
              · {row.source?.checkedAt ?? row.updatedAt}
            </span>
          </div>
        ))
      ) : (
        <div className="empty-state">
          <Search size={20} />
          <b>没有匹配规则</b>
          <span>请调整关键词。</span>
        </div>
      )}
      <DeliveryReadinessPanel baseUrl={baseUrl} />
    </>
  )
  const categoriesContent =
    categoriesData.mode === 'loading' ? (
      <LoadingState label="正在读取品类库…" />
    ) : categoriesData.mode === 'api_error' ? (
      <ErrorNotice
        message={`品类库读取失败：${categoriesError}`}
        onRetry={() => setCategoriesReloadKey((key) => key + 1)}
      />
    ) : categoriesData.mode === 'api_empty' ? (
      <div className="empty-state" data-testid="categories-api-empty">
        <Boxes size={20} />
        <b>API 暂无类目数据</b>
        <span>服务已成功返回空数据；未混入任何演示类目。</span>
      </div>
    ) : filteredCategories.length ? (
      filteredCategories.map((category) => (
        <article className="category-card" key={category.code}>
          <div className="category-card-head">
            <div className="category-icon">
              <Boxes size={18} />
            </div>
            <div>
              <span className="section-kicker">CATALOG {category.code}</span>
              <h3>{category.name}</h3>
            </div>
            <StatusChip tone="green">
              {category.status === 'active' ? '已生效' : category.status}
            </StatusChip>
          </div>
          <div className="category-meta">
            <span>
              <b>平台范围</b>
              {category.platforms
                .map((platform) => platformNames[platform] ?? platform)
                .join(' · ')}
            </span>
            <span>
              <b>属性模板</b>
              {category.fields.join('、')}
            </span>
          </div>
          <div className="category-card-foot">
            <span>最近更新：{category.updatedAt}</span>
            <button
              className="text-button"
              onClick={() => setSelectedCategory(category)}
            >
              查看字段映射 <ArrowRight size={14} />
            </button>
          </div>
        </article>
      ))
    ) : (
      <div className="empty-state">
        <Search size={20} />
        <b>没有匹配品类</b>
        <span>请调整关键词。</span>
      </div>
    )
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="section-kicker">POLICY & TAXONOMY</span>
          <h2>规则库与品类库</h2>
          <p>
            先选对品类，再按平台规则生成内容；每条规则都能追溯版本、适用范围和阻断原因。
          </p>
        </div>
        <StatusChip tone="neutral">
          <ShieldCheck size={15} />
          只读证据中心
        </StatusChip>
      </section>
      <div className="info-notice" role="status">
        <ShieldCheck size={16} />
        规则库负责表达、事实和发布前检查；品类库负责属性模板、平台字段映射和必填项。当前商家端只读，版本由管理员统一发布。
      </div>
      <section className="metric-grid">
        <MetricCard
          icon={ShieldCheck}
          label="生效规则包"
          value={ruleMetric}
          detail={ruleSource}
          tone="green"
        />
        <MetricCard
          icon={Boxes}
          label="已覆盖品类"
          value={categoryMetric}
          detail={categorySource}
          tone="blue"
        />
        <MetricCard
          icon={AlertCircle}
          label="属性模板字段"
          value={attributeMetric}
          detail="来自当前类目目录"
          tone="amber"
        />
        <MetricCard
          icon={CheckCircle2}
          label="字段映射"
          value={mappingStatus}
          detail="不伪造校验比例"
          tone="violet"
        />
      </section>
      <section className="library-toolbar">
        <div className="library-tabs" role="tablist" aria-label="规则与品类库">
          <button
            id="library-rules-tab"
            className={tab === 'rules' ? 'active' : ''}
            onClick={() => setTab('rules')}
            onKeyDown={(event) =>
              handleTabKeyDown(
                event,
                ['rules', 'categories'] as const,
                tab,
                setTab,
              )
            }
            role="tab"
            aria-selected={tab === 'rules'}
            aria-controls="library-rules-panel"
            tabIndex={tab === 'rules' ? 0 : -1}
          >
            <ShieldCheck size={15} />
            规则库 <span>{rows.length}</span>
          </button>
          <button
            id="library-categories-tab"
            className={tab === 'categories' ? 'active' : ''}
            onClick={() => setTab('categories')}
            onKeyDown={(event) =>
              handleTabKeyDown(
                event,
                ['rules', 'categories'] as const,
                tab,
                setTab,
              )
            }
            role="tab"
            aria-selected={tab === 'categories'}
            aria-controls="library-categories-panel"
            tabIndex={tab === 'categories' ? 0 : -1}
          >
            <Boxes size={15} />
            品类库 <span>{categories.length}</span>
          </button>
        </div>
        <label className="library-platform-filter">
          <span>规则平台</span>
          <select
            value={platform}
            onChange={(event) =>
              setPlatform(event.target.value as PlatformId | 'all')
            }
          >
            <option value="all">全部平台</option>
            {(Object.entries(platformNames) as Array<[PlatformId, string]>).map(
              ([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="library-search">
          <Search size={15} />
          <span className="sr-only">搜索规则或品类</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              tab === 'rules'
                ? '搜索规则名称、平台或版本'
                : '搜索品类、类目编码或属性'
            }
          />
        </label>
      </section>
      {tab === 'rules' ? (
        <section
          id="library-rules-panel"
          role="tabpanel"
          aria-labelledby="library-rules-tab"
          tabIndex={0}
          className="panel rules-list"
          aria-busy={rulesData.mode === 'loading'}
        >
          <div className="panel-heading">
            <div>
              <span className="section-kicker">ACTIVE RULE PACKS</span>
              <h3>生效规则包</h3>
            </div>
            <StatusChip
              tone={rulesData.mode === 'api_error' ? 'amber' : 'green'}
            >
              {rulesData.mode === 'loading'
                ? '读取中…'
                : rulesData.mode === 'api_error'
                  ? '读取失败'
                  : `${filteredRules.length} 个结果`}
            </StatusChip>
          </div>
          {rulesContent}
        </section>
      ) : (
        <section
          id="library-categories-panel"
          role="tabpanel"
          aria-labelledby="library-categories-tab"
          tabIndex={0}
        >
          <div className="info-notice" role="status">
            <Boxes size={16} />
            {categorySource}
            。类目状态仅代表当前数据源状态，提交平台前仍需做字段校验。
          </div>
          <section
            className="category-grid"
            aria-busy={categoriesData.mode === 'loading'}
          >
            {categoriesContent}
          </section>
        </section>
      )}
      {selectedCategory && categoriesData.mode !== 'api_error' && (
        <section
          className="panel category-mapping-detail"
          data-testid="category-mapping-detail"
          aria-label="字段映射详情"
        >
          <div className="panel-heading">
            <div>
              <span className="section-kicker">FIELD MAPPING</span>
              <h3>{selectedCategory.name} · 字段映射</h3>
              <p className="panel-subtitle">
                当前展示平台类目模板字段；提交前仍需以目标平台实时校验为准。
              </p>
            </div>
            <button
              className="text-button"
              onClick={() => setSelectedCategory(null)}
            >
              关闭
            </button>
          </div>
          <div className="category-meta">
            <span>
              <b>类目编码</b>
              {selectedCategory.code}
            </span>
            <span>
              <b>平台范围</b>
              {selectedCategory.platforms
                .map((platform) => platformNames[platform] ?? platform)
                .join(' · ')}
            </span>
          </div>
          <div className="mapping-field-list">
            {selectedCategory.fields.map((field) => (
              <span key={field}>
                <CheckCircle2 size={14} />
                {field}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function PublishModal({
  close,
  onComplete,
  onSubmit,
  returnFocus,
  target,
  preview,
}: {
  close: () => void
  onComplete: (jobId: string) => void
  onSubmit: () => Promise<string>
  returnFocus: HTMLElement | null
  target?: Target
  preview?: PublishPreview | null
}) {
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const submitLockRef = useRef(false)
  useEffect(() => {
    loadingRef.current = loading
  }, [loading])
  useEffect(() => {
    if (!submitError) return
    const firstFrame = window.requestAnimationFrame(() => {
      errorRef.current?.focus()
      window.requestAnimationFrame(() => errorRef.current?.focus())
    })
    return () => window.cancelAnimationFrame(firstFrame)
  }, [submitError])
  useEffect(() => {
    cancelRef.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loadingRef.current) close()
      if (event.key === 'Tab') {
        const focusable = Array.from(
          modalRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled)',
          ) ?? [],
        )
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      window.requestAnimationFrame(() => returnFocus?.focus())
    }
  }, [close, returnFocus])
  const submit = async () => {
    if (submitLockRef.current) return
    submitLockRef.current = true
    setSubmitError('')
    setLoading(true)
    try {
      const jobId = await onSubmit()
      onComplete(jobId)
    } catch (cause) {
      submitLockRef.current = false
      setLoading(false)
      setSubmitError(
        `发布未受理：${describeApiError(cause)} 请保留当前确认状态并重试；系统会复用同一幂等键。`,
      )
    }
  }
  const platform = target
    ? platformNames[target.platform]
    : preview
      ? platformNames[preview.task.platform]
      : '目标平台'
  const tone = target
    ? platformTone[target.platform]
    : preview
      ? platformTone[preview.task.platform]
      : 'orange'
  const title = preview?.version.body.title ?? target?.title ?? '目标商品'
  const changes = preview?.changes ?? []
  const actionLabel = preview?.operation === 'create' ? '创建' : '更新'
  const identityError = !target
    ? '发布目标缺少店铺身份，已阻止发布。'
    : (validateTargetStoreIdentity(target) ??
      (preview ? validateTaskStoreIdentity(target, preview.task) : null))
  const confirmationTarget = target?.storeName
    ? `店铺“${target.storeName}”`
    : '目标店铺'
  return (
    <div className="modal-layer" role="presentation">
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        aria-busy={loading}
      >
        <div className="modal-head">
          <div className="modal-icon">
            <Rocket size={21} />
          </div>
          <div>
            <span className="section-kicker">SECOND CONFIRMATION</span>
            <h2 id="publish-title">
              确认{actionLabel}
              {platform}商品
            </h2>
          </div>
          <button
            className="icon-button"
            onClick={close}
            disabled={loading}
            aria-label="关闭发布确认"
          >
            <X size={19} />
          </button>
        </div>
        <div className="modal-body">
          <div className="publish-target">
            <div className={`platform-logo ${tone}`}>
              {platform.slice(0, 1)}
            </div>
            <div>
              <b>{title}</b>
              <span>
                {target?.storeName && target.accountId
                  ? storeIdentityLabel(target)
                  : '店铺身份缺失'}
              </span>
              <span>
                {preview
                  ? `服务端快照 ${preview.remoteSnapshotHash.slice(0, 12)}…`
                  : '正在等待服务端发布预览'}
              </span>
            </div>
            <StatusChip tone={preview && !identityError ? 'green' : 'amber'}>
              {preview && !identityError ? (
                <>
                  <Check size={12} />
                  快照最新
                </>
              ) : (
                '不可确认'
              )}
            </StatusChip>
          </div>
          {identityError && <ErrorNotice message={identityError} compact />}
          <div className="change-summary">
            <h3>
              本次将{actionLabel}并写入 {changes.length || 0} 个字段
            </h3>
            {changes.length ? (
              changes.map((change) => (
                <div key={change}>
                  <span>{change}</span>
                  <b>{actionLabel}</b>
                </div>
              ))
            ) : (
              <div>
                <span>等待服务端 diff</span>
                <b>不可确认</b>
              </div>
            )}
            <div className="unchanged">
              <span>价格、库存、SKU、上下架状态</span>
              <b>不会修改</b>
            </div>
          </div>
          <div className="safety-note">
            <ShieldCheck size={18} />
            <div>
              <b>发布保护已开启</b>
              <span>
                请求使用一次性确认令牌和幂等键。若平台超时，系统将保留确认状态并使用同一幂等键重试。
              </span>
            </div>
          </div>
          {submitError && (
            <div
              className="inline-error"
              id="publish-submit-error"
              ref={errorRef}
              role="alert"
              aria-live="assertive"
              tabIndex={-1}
            >
              <AlertCircle size={16} />
              <span>{submitError}</span>
            </div>
          )}
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={loading || !preview || Boolean(identityError)}
            />
            <span>
              我确认将审核后的内容写入{confirmationTarget}的上述{platform}
              商品，并理解平台可能进入审核。
            </span>
          </label>
        </div>
        <div className="modal-actions">
          <button
            className="secondary"
            onClick={close}
            ref={cancelRef}
            disabled={loading}
          >
            返回检查
          </button>
          <button
            className="danger-action"
            disabled={
              !confirmed || loading || !preview || Boolean(identityError)
            }
            aria-describedby={submitError ? 'publish-submit-error' : undefined}
            onClick={() => void submit()}
          >
            {loading ? (
              <>
                <RefreshCw className="spin" size={16} />
                正在安全提交…
              </>
            ) : (
              <>
                <Rocket size={16} />
                {submitError
                  ? '重新安全提交'
                  : `确认${actionLabel}${platform}商品`}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const initialRoute = useRef<MerchantRoute>(
    merchantRouteFromLocation(window.location),
  ).current
  const [page, setPage] = useState<Page>(initialRoute.page)
  const [activeEntry, setActiveEntry] = useState<
    MerchantEntryPoint | undefined
  >(initialRoute.entry)
  const [mobileNav, setMobileNav] = useState(false)
  const [publishModal, setPublishModal] = useState(false)
  const [toast, setToast] = useState<ToastNotice | null>(null)
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const [modelStatus, setModelStatus] = useState<PlatformModelStatus | null>(
    null,
  )
  const [modelStatusRead, setModelStatusRead] = useState(false)
  const [target, setTarget] = useState<Target | undefined>()
  const [taskContext, setTaskContext] = useState<TaskContext | null>(null)
  const [publishPreview, setPublishPreview] = useState<PublishPreview | null>(
    null,
  )
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanel | null>(null)
  const [globalSearch, setGlobalSearch] = useState(initialRoute.searchQuery)
  const [routeTargetLoading, setRouteTargetLoading] = useState(
    Boolean(initialRoute.target),
  )
  const [routeTargetError, setRouteTargetError] = useState('')
  const [routeReloadKey, setRouteReloadKey] = useState(0)
  const publishTrigger = useRef<HTMLElement | null>(null)
  const utilityTrigger = useRef<HTMLElement | null>(null)
  const mobileMenuTrigger = useRef<HTMLButtonElement>(null)
  const toastTimer = useRef<number | null>(null)
  const publishPreviewLock = useRef(false)
  const routeRequestId = useRef(0)
  const mainContentRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const root = mainContentRef.current
    if (!root) return
    projectMerchantWriteControls(root, merchantReadOnly)
    const observer = new MutationObserver(() => projectMerchantWriteControls(root, merchantReadOnly))
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [page, utilityPanel, merchantReadOnly])
  const routeCanonicalized = useRef(false)
  const focusMainAfterNavigation = () =>
    focusMainAfterMerchantNavigation(
      mainContentRef.current,
      window.requestAnimationFrame.bind(window),
      () =>
        Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')) ||
        Boolean(mainContentRef.current?.closest('[inert]')),
    )
  useEffect(() => {
    const closeNav = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !mobileNav
      ) {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.search-box input')?.focus()
      }
    }
    window.addEventListener('keydown', closeNav)
    return () => window.removeEventListener('keydown', closeNav)
  }, [mobileNav])
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )
  useEffect(() => {
    const baseUrl = import.meta.env.VITE_API_BASE_URL
    if (!baseUrl) return
    fetchApiHealth(baseUrl)
      .then(() => setApiOnline(true))
      .catch(() => setApiOnline(false))
    fetchPlatformModelStatus(baseUrl)
      .then(status => {
        setModelStatus(status)
        setApiOnline(true)
      })
      .catch(() => setModelStatus(null))
      .finally(() => setModelStatusRead(true))
  }, [])
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
  const refreshModelStatus = () => {
    if (!apiBaseUrl || !modelStatusRead) return
    setModelStatusRead(false)
    fetchPlatformModelStatus(apiBaseUrl)
      .then(setModelStatus)
      .catch(() => setModelStatus(null))
      .finally(() => setModelStatusRead(true))
  }
  const applyLocation = (
    location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  ) => {
    const requestId = ++routeRequestId.current
    const route = merchantRouteFromLocation(location)
    setPage(route.page)
    setActiveEntry(route.entry)
    setGlobalSearch(route.searchQuery)
    setTaskContext(null)
    setPublishPreview(null)
    setPublishModal(false)
    setUtilityPanel(null)
    setMobileNav(false)
    setRouteTargetError('')
    if (!route.target) {
      setTarget(undefined)
      setRouteTargetLoading(false)
      focusMainAfterNavigation()
      return
    }
    setTarget(undefined)
    setRouteTargetLoading(true)
    if (!apiBaseUrl) {
      setRouteTargetError('未配置 API，无法从深链安全恢复商品或任务上下文。')
      setRouteTargetLoading(false)
      focusMainAfterNavigation()
      return
    }
    resolveMerchantRouteTarget(apiBaseUrl, route.target)
      .then((nextTarget) => {
        if (requestId === routeRequestId.current) setTarget(nextTarget)
      })
      .catch((cause) => {
        if (requestId === routeRequestId.current)
          setRouteTargetError(describeApiError(cause))
      })
      .finally(() => {
        if (requestId === routeRequestId.current) {
          setRouteTargetLoading(false)
          focusMainAfterNavigation()
        }
      })
  }
  useEffect(() => {
    if (!routeCanonicalized.current) {
      routeCanonicalized.current = true
      const canonicalUrl = urlForMerchantRoute(window.location, initialRoute)
      if (
        `${window.location.pathname}${window.location.search}` !==
          canonicalUrl ||
        window.location.hash
      )
        window.history.replaceState(null, '', canonicalUrl)
    }
    applyLocation(window.location)
    const onPopState = () => applyLocation(window.location)
    window.addEventListener('popstate', onPopState)
    return () => {
      routeRequestId.current += 1
      window.removeEventListener('popstate', onPopState)
    }
  }, [apiBaseUrl, routeReloadKey])
  useEffect(() => {
    if (page === 'publish' && taskContext?.task) {
      window.localStorage.setItem(
        'merchant-studio:last-publish-task',
        taskContext.task.id,
      )
      return
    }
    if (page !== 'publish' || !apiBaseUrl || taskContext) return
    const taskId = window.localStorage.getItem(
      'merchant-studio:last-publish-task',
    )
    if (!taskId) return
    let cancelled = false
    fetchTask(apiBaseUrl, taskId)
      .then(async (task) => {
        if (task.state !== 'approved')
          throw new Error('last publish task is no longer approved')
        const product = await fetchProduct(apiBaseUrl, task.productId)
        if (cancelled) return
        const versions = await fetchContentVersions(apiBaseUrl, task.id)
        const version = versions.find((item) => item.state === 'approved')
        if (!version)
          throw new Error('last publish task has no approved content version')
        if (cancelled) return
        assertProductTargetIdentity(product, {
          productId: task.productId,
          platform: task.platform,
          accountId: task.accountId,
        })
        setTarget({
          productId: task.productId,
          platform: task.platform,
          title: product.title,
          remoteId: product.remoteId,
          accountId: product.accountId,
          storeName: product.storeName,
          taskId: task.id,
        })
        setTaskContext({ task, version })
      })
      .catch(() => {
        if (!cancelled)
          window.localStorage.removeItem('merchant-studio:last-publish-task')
      })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, page, taskContext])
  const navigateTo = (
    nextPage: Page,
    options: {
      target?: Target
      searchQuery?: string
      entry?: MerchantEntryPoint
      clearContext?: boolean
    } = {},
  ) => {
    const targetForRoute =
      options.target ?? (nextPage === 'rules' && target ? target : undefined)
    const resolvedTarget =
      targetForRoute && !targetForRoute.taskId && !targetForRoute.taskIntentKey
        ? { ...targetForRoute, taskIntentKey: crypto.randomUUID() }
        : targetForRoute
    const nextTarget = resolvedTarget
      ? resolvedTarget.taskId
        ? { kind: 'task' as const, taskId: resolvedTarget.taskId }
        : {
            kind: 'product' as const,
            productId: resolvedTarget.productId,
            platform: resolvedTarget.platform,
            accountId: resolvedTarget.accountId,
            intentKey: resolvedTarget.taskIntentKey,
          }
      : undefined
    const url = urlForMerchantRoute(window.location, {
      page: nextPage,
      target: nextTarget,
      searchQuery: options.searchQuery,
      entry: options.entry,
    })
    window.history.pushState(null, '', url)
    routeRequestId.current += 1
    setPage(nextPage)
    setActiveEntry(options.entry)
    setRouteTargetLoading(false)
    setRouteTargetError('')
    setMobileNav(false)
    setPublishModal(false)
    setUtilityPanel(null)
    if (nextPage === 'task') setTarget(resolvedTarget)
    if (options.clearContext) {
      setTarget(resolvedTarget)
      setTaskContext(null)
      setPublishPreview(null)
    }
    focusMainAfterNavigation()
  }
  const openUtility = (
    panel: UtilityPanel,
    returnTarget?: HTMLElement | null,
  ) => {
    utilityTrigger.current =
      returnTarget ?? (document.activeElement as HTMLElement | null)
    setUtilityPanel(panel)
  }
  const closeUtility = () => {
    const returnTarget = utilityTrigger.current
    setUtilityPanel(null)
    window.requestAnimationFrame(() => returnTarget?.focus())
  }
  const showToast = (
    message: string,
    tone: ToastNotice['tone'],
    duration = 5000,
  ) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast({ message, tone })
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
      toastTimer.current = null
    }, duration)
  }
  const openPublish = async () => {
    if (publishPreviewLock.current) return
    if (!taskContext?.task || !taskContext.version) {
      showToast('请先选择商品并完成内容审核', 'error')
      return
    }
    if (!target) {
      showToast(
        '发布目标缺少店铺身份，已阻止发布。请返回商品列表重新选择。',
        'error',
      )
      return
    }
    if (!apiBaseUrl) {
      showToast('未配置 API，离线演示不会创建或伪造发布任务。', 'error')
      return
    }
    const currentIdentityError =
      validateTargetStoreIdentity(target) ??
      validateTaskStoreIdentity(target, taskContext.task)
    if (currentIdentityError) {
      showToast(currentIdentityError, 'error')
      return
    }
    const accountId = target.accountId
    if (!accountId) {
      showToast('发布目标缺少店铺账号，已阻止发布。', 'error')
      return
    }
    publishTrigger.current = document.activeElement as HTMLElement | null
    publishPreviewLock.current = true
    setPublishPreview(null)
    try {
      const preview = await preparePublish(apiBaseUrl, taskContext.task.id)
      const previewIdentityError =
        validateTaskStoreIdentity(target, preview.task) ??
        validatePublishPreview({
          expectedTaskId: taskContext.task.id,
          expectedContentVersionId: taskContext.version.id,
          expectedAccountId: accountId,
          previewTaskId: preview.task.id,
          previewContentVersionId: preview.version.id,
          previewAccountId: preview.task.accountId,
          confirmationHash: preview.confirmationHash,
          remoteSnapshotHash: preview.remoteSnapshotHash,
        })
      if (previewIdentityError) {
        showToast(previewIdentityError, 'error')
        return
      }
      setPublishPreview(preview)
      setPublishModal(true)
    } catch (cause) {
      showToast(`发布预览失败：${describeApiError(cause)}`, 'error')
    } finally {
      publishPreviewLock.current = false
    }
  }
  const submitPublish = async () => {
    if (!apiBaseUrl)
      throw new Error('未配置 API，离线演示不会创建或伪造发布任务。')
    if (!taskContext?.task || !taskContext.version || !target)
      throw new Error(
        '请先完成目标商品的内容审核，并确认完整店铺身份后再进入发布。',
      )
    const task = taskContext.task
    const draft = taskContext.version
    const preview = publishPreview
    if (!preview)
      throw new Error('发布预览已失效，请返回检查并重新进入发布确认。')
    const identityError =
      validateTargetStoreIdentity(target) ??
      validateTaskStoreIdentity(target, task) ??
      validateTaskStoreIdentity(target, preview.task)
    if (identityError) throw new Error(identityError)
    const accountId = target.accountId
    if (!accountId) throw new Error('发布目标缺少店铺账号，已阻止发布。')
    const previewError = validatePublishPreview({
      expectedTaskId: task.id,
      expectedContentVersionId: draft.id,
      expectedAccountId: accountId,
      previewTaskId: preview.task.id,
      previewContentVersionId: preview.version.id,
      previewAccountId: preview.task.accountId,
      confirmationHash: preview.confirmationHash,
      remoteSnapshotHash: preview.remoteSnapshotHash,
    })
    if (previewError) throw new Error(previewError)
    const submission = createPublishSubmission({
      taskId: task.id,
      contentVersionId: draft.id,
      accountId,
      confirmationHash: preview.confirmationHash,
      remoteSnapshotHash: preview.remoteSnapshotHash,
    })
    const job = await confirmPublish(
      apiBaseUrl,
      submission.body,
      submission.idempotencyKey,
    )
    const receiptError = validatePublishReceipt(submission, job)
    if (receiptError) throw new Error(receiptError)
    return job.id
  }
  const completePublish = (jobId: string) => {
    if (taskContext?.task)
      window.localStorage.setItem(
        'merchant-studio:last-publish-task',
        taskContext.task.id,
      )
    setPublishModal(false)
    setPublishPreview(null)
    navigateTo('publish')
    showToast(
      `发布请求已受理：${jobId}。平台生效前会持续显示为“审核中”。`,
      'info',
    )
  }
  const openCorrection = async (job: PublishJob) => {
    if (!apiBaseUrl) return
    try {
      const rejectedTask = await fetchTask(apiBaseUrl, job.taskId)
      const rejectedProduct = assertProductTargetIdentity(
        await fetchProduct(apiBaseUrl, rejectedTask.productId),
        {
          productId: rejectedTask.productId,
          platform: rejectedTask.platform,
          accountId: rejectedTask.accountId,
        },
      )
      const correctionTarget = {
        productId: rejectedTask.productId,
        platform: rejectedTask.platform,
        title: rejectedProduct.title,
        remoteId: rejectedProduct.remoteId,
        accountId: rejectedTask.accountId,
        storeName: rejectedProduct.storeName,
        taskId: rejectedTask.id,
      }
      const identityError =
        validateProductStoreIdentity(correctionTarget, rejectedProduct) ??
        validateTaskStoreIdentity(correctionTarget, rejectedTask) ??
        (job.accountId && job.accountId !== rejectedTask.accountId
          ? '发布回执店铺账号与任务不一致，已阻止修正。'
          : null)
      if (identityError) throw new Error(identityError)
      navigateTo('task', { target: correctionTarget, clearContext: true })
      showToast(
        '已定位到被驳回的内容。请按平台原因修改；保存后会生成待审核的新版本。',
        'info',
        6000,
      )
    } catch (cause) {
      showToast(`无法打开修正任务：${describeApiError(cause)}`, 'error')
    }
  }
  const searchProducts = () => {
    const query = globalSearch.trim()
    if (!query) return
    navigateTo('products', { searchQuery: query, clearContext: true })
  }
  return (
    <div className="app-shell" data-merchant-role={merchantRole || 'workspace_owner'} data-merchant-permission={merchantReadOnly ? 'read-only' : 'write'}>
      {merchantReadOnly && (
        <div className="info-notice" role="status" data-testid="merchant-read-only-banner">
          当前账号为只读角色，商品、素材、任务、充值和发布等写操作已禁用；如需修改，请联系工作区管理员。
        </div>
      )}
      <button
        className="skip-link"
        inert={publishModal || Boolean(utilityPanel)}
        onClick={() => mainContentRef.current?.focus()}
      >
        跳到主要内容
      </button>
      <Sidebar
        page={page}
        setPage={(nextPage) =>
          navigateTo(nextPage, { clearContext: nextPage === 'task' })
        }
        open={mobileNav}
        close={() => setMobileNav(false)}
        returnFocus={mobileMenuTrigger.current}
        backgroundInert={publishModal || Boolean(utilityPanel)}
        onOpenUtility={openUtility}
        onOpenEntry={(entry) =>
          navigateTo('products', { entry, clearContext: true })
        }
        activeEntry={activeEntry}
        target={target}
      />
      <div
        className="app-content"
        inert={mobileNav || publishModal || Boolean(utilityPanel)}
      >
        <div className="main-shell">
          <Topbar
            page={page}
            openMenu={() => setMobileNav(true)}
            menuOpen={mobileNav}
            menuButtonRef={mobileMenuTrigger}
            apiOnline={apiOnline}
            apiBaseUrl={apiBaseUrl}
            onOpenUtility={openUtility}
            searchQuery={globalSearch}
            onSearchQuery={setGlobalSearch}
            onSearch={searchProducts}
          />
          <EnvironmentStatusBanner
            apiOnline={apiOnline}
            apiBaseUrl={apiBaseUrl}
            modelStatus={modelStatus}
            modelStatusRead={modelStatusRead}
            onOpenHealth={() => openUtility('health')}
          />
          <main
            ref={mainContentRef}
            tabIndex={-1}
            className={`page ${page === 'task' ? 'task-page' : ''}`}
          >
            {routeTargetLoading ? (
              <LoadingState label="正在从链接安全恢复商品与任务上下文…" />
            ) : routeTargetError ? (
              <section
                className="page-stack"
                data-testid="route-recovery-error"
              >
                <ErrorNotice
                  message={`无法恢复当前链接：${routeTargetError}`}
                  onRetry={() => setRouteReloadKey((key) => key + 1)}
                  focusOnMount
                />
                <button
                  className="primary"
                  onClick={() => navigateTo('products', { clearContext: true })}
                >
                  回到商品与素材
                </button>
              </section>
            ) : (
              <>
                {page === 'overview' && (
                  <Overview
                    goTask={() =>
                      navigateTo('products', { clearContext: true })
                    }
                    goProducts={() => navigateTo('products')}
                    goTasks={() => navigateTo('task', { clearContext: true })}
                    baseUrl={apiBaseUrl}
                    onOpenUtility={openUtility}
                    onOpenEntry={(entry) =>
                      navigateTo('products', { entry, clearContext: true })
                    }
                  />
                )}
                {page === 'products' && (
                  <Products
                    baseUrl={apiBaseUrl}
                    initialQuery={globalSearch}
                    initialEntry={activeEntry}
                    onSelectTarget={(next) =>
                      navigateTo('task', { target: next, clearContext: true })
                    }
                    onOpenTasks={() =>
                      navigateTo('task', { clearContext: true })
                    }
                    onConnectStores={() =>
                      navigateTo('overview', { clearContext: true })
                    }
                  />
                )}
                {page === 'task' && (
                  <TaskWorkspace
                    openPublish={openPublish}
                    baseUrl={apiBaseUrl}
                    target={target}
                    onContext={setTaskContext}
                    onSelectTarget={(next) =>
                      navigateTo('task', { target: next, clearContext: true })
                    }
                    onTaskResolved={(taskId) =>
                      window.history.replaceState(
                        null,
                        '',
                        urlForMerchantRoute(window.location, {
                          page: 'task',
                          target: { kind: 'task', taskId },
                        }),
                      )
                    }
                    onBack={() => navigateTo('task', { clearContext: true })}
                    onBackToProducts={() =>
                      navigateTo('products', { clearContext: true })
                    }
                  />
                )}
                {page === 'publish' && (
                  <PublishCenter
                    openPublish={openPublish}
                    openCorrection={openCorrection}
                    baseUrl={apiBaseUrl}
                    canOpenPublish={Boolean(
                      taskContext?.task && taskContext.version,
                    )}
                  />
                )}
                {page === 'rules' && <Rules baseUrl={apiBaseUrl} />}
              </>
            )}
          </main>
        </div>
      </div>
      {publishModal && target && (
        <PublishModal
          close={() => setPublishModal(false)}
          preview={publishPreview}
          target={target}
          onSubmit={submitPublish}
          onComplete={completePublish}
          returnFocus={publishTrigger.current}
        />
      )}
      {utilityPanel && (
        <UtilityPanel
          panel={utilityPanel}
          apiOnline={apiOnline}
          apiBaseUrl={apiBaseUrl}
          modelStatus={modelStatus}
          modelStatusRead={modelStatusRead}
          onRefreshModelStatus={refreshModelStatus}
          onClose={closeUtility}
        />
      )}
      <div
        className={`toast ${toast ? `visible ${toast.tone}` : ''}`}
        role={toast?.tone === 'error' ? 'alert' : 'status'}
        aria-live={toast?.tone === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {toast?.tone === 'error' ? (
          <AlertCircle size={18} />
        ) : toast?.tone === 'info' ? (
          <CircleHelp size={18} />
        ) : (
          <CheckCircle2 size={18} />
        )}
        <span>{toast?.message}</span>
      </div>
    </div>
  )
}
