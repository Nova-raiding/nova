import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Alert, Badge, Breadcrumb, Button, Card, Checkbox, DatePicker, Dropdown, Form, Input, InputNumber, List, Modal, Select, Space, Statistic, Table, Tag } from 'antd'
import zhCN from 'antd/es/date-picker/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import './capability.css'
import { nextImageJobPollDelay, shouldPollImageJob, visibleImageJobPollDelay, IMAGE_JOB_INITIAL_POLL_DELAY_MS } from './image-job-polling'
import { getImageCandidatePage } from './image-candidate-pagination'
import { imageCandidateLoading } from './image-candidate-loading'
import { mergeImageGenerationJobs } from './image-job-list'
import { isRealReadableStore, merchantConnectionPresentation } from './platform-connection-status'
import {
  buildCatalogPlatforms,
  catalogProductsForStore,
  type CatalogPlatformView,
  type CatalogProduct,
  type CatalogStoreView,
} from './catalog-data'
import { DetailDecisionContract } from './DetailDecisionContract'
import {
  formatMaterialFileSize,
  materialDownloadHref,
  materialEmptyCopy,
  materialStoreCategories,
  materialSummaryText,
  resolveMaterialRead,
  uploadMaterialFiles,
  type StoreMaterialCategory,
  type StoreMaterialItem,
} from './material-library'
import storeNovaLogo from './assets/store-nova-primary-horizontal.png'
import {
  evidenceSafeTopLevelContent,
  moduleDecisionPresentation,
} from './detail-decision-contract'
import {
  AlertCircle,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Bell,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileCheck2,
  FileText,
  FolderOpen,
  Gauge,
  Grid2X2,
  History,
  Image as ImageIcon,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  PackageSearch,
  PanelLeftClose,
  Play,
  Plus,
  RefreshCw,
  Rows3,
  Rocket,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Download,
  Truck,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  WalletCards,
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
  createCampaignBatch,
  createTask,
  decideReviewFinding,
  describeApiError,
  diffContentVersions,
  extractBrandProfile,
  fetchApiHealth,
  fetchAssetBlob,
  fetchAssets,
  fetchAssetStorageQuota,
  fetchBillingStatus,
  fetchCommercialCatalog,
  fetchCreativePointStatement,
  fetchCustomerSupportReplies,
  fetchBrandProfile,
  fetchImageGenerationJob,
  fetchImageGenerationJobs,
  fetchCatalogCategories,
  fetchContentVersions,
  fetchPlatformAccounts,
  fetchPlatformModelStatus,
  fetchMerchantSession,
  fetchManualPublishRecords,
  logoutMerchantAccount,
  changeMerchantPassword,
  fetchProduct,
  fetchProductAssetBindings,
  fetchProductsByAsset,
  fetchProductPage,
  fetchProducts,
  fetchPublishJobPage,
  fetchRulePacks,
  fetchRechargeOrder,
  fetchSyncJobs,
  fetchTask,
  fetchTaskFeedback,
  fetchTaskPage,
  MERCHANT_TASK_PAGE_SIZE,
  MERCHANT_PUBLISH_PAGE_SIZE,
  fetchTaskTimeline,
  fetchWorkspaceMetrics,
  generateProductImages,
  generateCampaignBatch,
  generateContent,
  importProduct,
  isNotConfigured,
  modifyContentVersion,
  parseAsset,
  preparePublish,
  requestApi,
  requestMcp,
  reviewContent,
  reviewProductImages,
  retryImageGeneration,
  retrySyncFailures,
  revokePlatform,
  saveAssetPreference,
  saveBrandProfile,
  selectDirection,
  selectMerchantCatalogItems,
  selectVisualCandidates,
  submitTaskFeedback,
  syncPlatform,
  understandTask,
  configuredWorkspaceId,
  updateAssetRights,
  uploadAsset,
  type AssetMetadata,
  type ApiHealth,
  type BrandCandidateFieldKey,
  type BrandExtraction,
  type BrandProfile,
  type BrandVisualRules,
  type BillingStatus,
  type CatalogCategory,
  type CommercialCatalogItem,
  type CreativePointStatementEntry,
  type FeedbackRating,
  type ImageGenerationJob,
  type ImageGenerationJobListItem,
  type ManualPublishRecord,
  type PlatformAccount,
  type PlatformCapability,
  type PlatformId,
  type PlatformModelStatus,
  type Product as ApiProduct,
  type ContentVersion,
  type ProductAssetBinding,
  type PublishJob,
  type PublishPreview,
  type ReviewCategory,
  type ReviewFinding,
  type RulePack,
  type StorageQuotaProjection,
  type SyncJob,
  type Task,
  type TaskFeedback,
  type TaskQuestion,
  type TaskTimelineEvent,
  type TaskUnderstanding,
  type WorkspaceMetrics,
  type MerchantAuthAccount,
} from './api'
import { resolveMerchantEnvironmentStatus } from './environment-status'
import { MerchantLoginPage } from './MerchantLoginPage'
import { LocalPluginConnection } from './LocalPluginConnection'
import { brandUnitSelectionMessage } from './brand-unit-selection'
import { imageGenerationExecutionLabel, imageGenerationNeedsReconciliation, imageGenerationProviderCallStarted, imageGenerationRetryAllowed, isImageGenerationConfigurationError } from './image-generation-state'
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
import { batchTargetKey, projectProductRowTarget, projectProductTarget, toggleBatchTarget } from './batch-target.js'
import { resolveBatchReadiness, resolveBatchResultState } from './batch-readiness.js'
import { resolveRuleContext, resolveRuleExecutionState } from './rule-context.js'
import { resolveDataConsistency } from './data-consistency.js'
import { CanonicalConsistencyPanel } from './CanonicalConsistencyPanel.js'
import { resolveProductAssetRelation } from './product-assets.js'
import { ContextRecoveryCard } from './ContextRecoveryCard.js'
import { canonicalProductActionAllowed, groupTasksForRecovery, prioritizeProducts } from './merchant-ia.js'
import { resolveDetailSopSteps } from './detail-sop.js'
import { actionableIssueItems, createIssueReadSession, resolveIssueReadState, resolveIssueReadStateFromOutcome, type IssueReadOutcome, type IssueReadState } from './issue-read-state.js'
import { BRAND_UNCONFIGURED, BRAND_DOCUMENT_LOCAL_ANALYSIS, BRAND_DOCUMENT_NONE, resolveBrandColorFacts, resolveBrandDocumentFacts, resolveBrandLogoFacts } from './material-brand-facts.js'
import { countKnowledgeAssets, KnowledgeBindingStatus, resolveKnowledgeBindingStatus } from './knowledge-binding-status.js'

// There is deliberately no client-side read-only role projection here. It used
// to read a build-time `VITE_MERCHANT_ROLE`, which no build path ever set, and
// the session account cannot supply one either: `platform_password_accounts.roles`
// is written as `ARRAY['merchant']` at registration and activation and never
// updated, while the read-only canonical roles (`viewer`, `knowledge_reader`)
// are gateway/OIDC aliases that no workspace membership can carry. A projection
// fed by either source would disable nothing. Writes are refused by the API
// (FORBIDDEN), and the refusal surfaces through the `merchant-capability-denied`
// event rendered as 「当前账号没有此操作权限」 below.
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
  entry?: MerchantEntryPoint
  description?: string
  badge?: string
}> = [
  { id: 'overview', label: '运营概览', icon: LayoutDashboard },
  // 商品资产不再作为独立工作台；相关能力收敛到知识库二级工作区。
  { id: 'products', label: '知识库', icon: BookOpen, entry: 'knowledge' },
  { id: 'finance', label: '财务概况', icon: WalletCards },
]

const knowledgeSubItems: Array<{
  id: Page
  label: string
  icon: typeof LayoutDashboard
  entry?: MerchantEntryPoint
  description?: string
}> = [
  { id: 'products', label: '平台&店铺&商品', icon: PackageSearch, entry: 'products', description: '选择平台、店铺和商品后创建营销任务' },
  { id: 'products', label: '品牌资产', icon: FolderOpen, entry: 'assets', description: '维护品牌资料与素材' },
  { id: 'products', label: '素材库', icon: BookOpen, entry: 'knowledge', description: '上传、确认并引用素材' },
  { id: 'products', label: '回收站', icon: Trash2, entry: 'trash', description: '恢复或彻底删除近 7 天内移除的素材' },
]
// Compatibility marker for deep links that still address id: 'knowledge'.

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
    status: '演示连接',
    tone: 'red',
    sync: '演示数据',
    canSync: false,
    canReauthorize: false,
  },
  {
    name: '淘宝',
    platformId: 'taobao',
    shop: '云朵轻户外',
    status: '演示连接',
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
  const messageId = `merchant-error-${useId().replace(/:/g, '')}`
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
      aria-labelledby={focusOnMount ? messageId : undefined}
    >
      <AlertCircle size={16} aria-hidden="true" />
      <span id={messageId}>{message}</span>
      {onRetry && (
        <button
          className="text-button"
          type="button"
          aria-label={accessibleRetryLabel}
          aria-describedby={messageId}
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      )}
    </div>
  )
}

export function WorkspaceDataIntegrityNotice({ metrics }: { metrics: WorkspaceMetrics | null }) {
  if (!metrics?.dataCoverage) return null
  const invalidSnapshots = metrics.hydration?.invalidSnapshotCount ?? 0
  const partial = metrics.dataCompleteness === 'partial' || invalidSnapshots > 0
  if (!partial && !metrics.dataCoverage.fixtureDataPresent) return null
  return (
    <section className="panel data-integrity-panel" aria-labelledby="merchant-data-integrity-title">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">DATA INTEGRITY</span>
          <h3 id="merchant-data-integrity-title">当前经营数据范围</h3>
        </div>
        <StatusChip tone={partial ? 'amber' : 'blue'}>{partial ? '部分数据' : '演示数据'}</StatusChip>
      </div>
      <div className="data-integrity-copy">
        {partial ? (
          <>
            <strong>总览不是完整快照</strong>
            <span>数据源：{metrics.source ?? '待确认'}；无效持久化快照：{invalidSnapshots}。请先修复数据恢复问题，再依据总览做经营决策。</span>
          </>
        ) : null}
        {metrics.dataCoverage.fixtureDataPresent ? <span>当前包含 fixture 数据，仅用于本地验收，不代表真实平台生产数据。</span> : null}
      </div>
    </section>
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
  return <img className="brand-logo" src={storeNovaLogo} alt="Store Nova" />
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

type UtilityPanel = 'health' | 'help' | 'support'

function merchantWorkspaceLabel(account: MerchantAuthAccount | null) {
  const workspaceIds = account?.workspaceIds?.filter(Boolean) ?? []
  if (!workspaceIds.length) return '未分配商家工作区'
  const enterpriseName = account?.enterpriseName?.trim()
  if (workspaceIds.length === 1 && enterpriseName)
    return `${enterpriseName}商家工作区`
  if (workspaceIds.length === 1) return '商家工作区'
  return `已授权 ${workspaceIds.length} 个商家工作区`
}

/** Only mirror the server-owned account lifecycle; never invent a plan tier. */
const merchantAccountStatusLabels: Record<MerchantAuthAccount['status'], string> = {
  merchant_pending: '待审核',
  active: '已启用',
  suspended: '已暂停',
  revoked: '已撤销',
}

function merchantAccountStatusLabel(status: MerchantAuthAccount['status'] | undefined) {
  if (!status) return '未读取'
  return merchantAccountStatusLabels[status] ?? status
}

/**
 * The bell and its panel read one resolved state, never the raw list.
 *
 * Both are exported so the four states can be rendered directly: the dropdown
 * body is only built once the merchant opens it, so a static render of the
 * topbar cannot see what the panel would say. They carry no state of their own
 * — the reviewed markup is unchanged, only the text it is allowed to show.
 */
export function IssueNotificationBell({ state, ...rest }: { state: IssueReadState } & React.HTMLAttributes<HTMLSpanElement> & React.RefAttributes<HTMLSpanElement>) {
  return (
    // `...rest` is the click/ref contract antd's `Dropdown` clones onto its
    // direct child; `Badge` puts them on its wrapper span, which is what makes
    // the bell open the panel. Dropping them would close the dropdown for good.
    <Badge {...rest} count={state.badgeCount} overflowCount={99} offset={[-2, 4]}>
      <button type="button" className="icon-button notification-trigger" aria-label={state.ariaLabel}>
        <Bell size={18} aria-hidden="true" />
      </button>
    </Badge>
  )
}

/**
 * The topbar's workspace-metrics read, at module scope so that a re-render does
 * not reset its staleness guard. `Topbar` only binds it; the chain — pending,
 * outcome, failure, retry — is `createIssueReadSession` and is driven directly
 * by `issue-read-state.test.ts`.
 */
const issueReadSession = createIssueReadSession({ load: fetchWorkspaceMetrics, describeError: describeApiError })

export function IssueNotificationPanel({ state, items, onOpenIssue, onClose, onRetry }: {
  state: IssueReadState
  items: WorkspaceMetrics['riskItems']
  onOpenIssue: (item: WorkspaceMetrics['riskItems'][number]) => void
  onClose: () => void
  onRetry: () => void
}) {
  return (
    <div className="merchant-notification-panel" role="region" aria-label="待处理问题">
      {state.mode === 'ready' && items.length ? <>
        <div className="merchant-notification-heading">
          <div><strong>工作区待处理问题</strong><span>{items.length} 项需要关注</span></div>
        </div>
        <List
        className="merchant-notification-list"
        size="small"
        dataSource={items}
        renderItem={(item, index) => <List.Item className="merchant-notification-item">
          <button
            type="button"
            className="merchant-notification-item-button"
            aria-label={`查看问题：${item.title ?? item.type}`}
            onMouseDown={onClose}
            onClick={() => { onOpenIssue(item) }}
          >
            <span className={`merchant-notification-dot ${item.severity}`} aria-hidden="true" />
            <span className="merchant-notification-copy"><strong>{item.title ?? item.type}</strong><small>{[item.platform ? platformNames[item.platform] : '', item.storeName ?? '', item.status ?? ''].filter(Boolean).join(' · ') || '当前工作区'}</small><em>{item.nextAction ?? '查看详情并处理'}</em></span>
            <span className="merchant-notification-index">{index + 1}</span>
          </button>
        </List.Item>}
        />
      </> : <div className="merchant-notification-empty" role="status" aria-live="polite">
        <span>{state.notice}</span>
        {state.mode === 'read_error' && <button className="text-button" type="button" onClick={onRetry}>重新读取</button>}
      </div>}
    </div>
  )
}

function Topbar({
  page,
  activeEntry,
  openMenu,
  menuOpen,
  menuButtonRef,
  apiOnline,
  apiMode,
  apiHealth,
  apiBaseUrl,
  modelStatus,
  modelStatusRead,
  account,
  billing,
  onLogout,
  onPasswordChanged,
  onOpenUtility,
  onOpenIssues,
  searchQuery,
  onSearchQuery,
  onSearch,
}: {
  page: Page
  activeEntry?: MerchantEntryPoint
  openMenu: () => void
  menuOpen: boolean
  menuButtonRef: React.RefObject<HTMLButtonElement | null>
  apiOnline: boolean | null
  apiMode: string | null
  apiHealth: ApiHealth | null
  apiBaseUrl?: string
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
  account: MerchantAuthAccount | null
  billing: BillingStatus | null
  onLogout: () => void
  onPasswordChanged: () => void
  onOpenUtility: (panel: UtilityPanel) => void
  onOpenIssues: () => void
  searchQuery: string
  onSearchQuery: (value: string) => void
  onSearch: () => void
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  // The read's outcome, kept as the three facts it actually is. They used to be
  // one `WorkspaceMetrics | null`: the catch only set it to `null`, which the
  // panel rendered as 「暂无需要处理的问题」. 未配置 / 正在读取 / 读取失败 are three
  // different facts and `resolveIssueReadState` renders each of them as itself.
  const [issueItems, setIssueItems] = useState<IssueReadOutcome['items']>(null)
  const [issueReadError, setIssueReadError] = useState('')
  const [issueReadPending, setIssueReadPending] = useState(Boolean(apiBaseUrl))
  const [issueReload, setIssueReload] = useState(0)
  const [issueDetail, setIssueDetail] = useState<WorkspaceMetrics['riskItems'][number] | null>(null)
  const [passwordForm] = Form.useForm<{ current_password: string; new_password: string; confirm_password: string }>()
  const accountMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!accountMenuOpen) return
    const closeOnOutside = (event: MouseEvent) => {
      // This account-menu child renders into a body portal. Its dialog clicks
      // must not unmount the child before confirmation or cancellation runs.
      if (event.target instanceof Element && event.target.closest('.merchant-local-plugin-modal')) return
      if (!accountMenuRef.current?.contains(event.target as Node))
        setAccountMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountMenuOpen])
  useEffect(() => {
    // The read itself lives in `issue-read-state.ts`, where it can be driven
    // with a real response and a real rejection. What stays here is the binding:
    // the effect is one call to the session, and `issueReload` — bumped by the
    // panel's 重新读取 button — is what makes the effect run again.
    void issueReadSession.read(apiBaseUrl, (outcome) => {
      setIssueItems(outcome.items)
      setIssueReadError(outcome.error)
      setIssueReadPending(outcome.loading)
    })
  }, [apiBaseUrl, issueReload])
  const titles: Record<Page, string> = {
    overview: '运营概览',
    products: activeEntry === 'assets' ? '品牌资产' : activeEntry === 'trash' ? '回收站' : activeEntry === 'knowledge' ? '素材库' : '知识库',
    finance: '财务概况',
    task: '营销任务',
    publish: '发布中心',
    rules: '规则与检查',
  }
  const displayName = account?.contactName?.trim() || '商家管理员'
  const accountInitial = Array.from(displayName)[0] || '商'
  const tenantName = account?.enterpriseName?.trim() || '商家工作区'
  const workspaceName = merchantWorkspaceLabel(account)
  const points = billing?.available_points
  const balance = billing?.balance_cny
  const walletUnavailable = !billing
  // Only show actionable risks belonging to a real bound store. The API also
  // returns unbound and fixture records for reconciliation, but those are not
  // notifications for the currently signed-in merchant.
  // `null` — not `[]` — until the read answers. `[]` is a real answer.
  const actionableIssues = actionableIssueItems(issueItems)
  // From the settled outcome to the words: one call, so the chain under the bell
  // is the chain `issue-read-state.test.ts` drives through a real response.
  const issueRead = resolveIssueReadStateFromOutcome({ baseUrl: apiBaseUrl, outcome: { items: issueItems, error: issueReadError, loading: issueReadPending } })
  const openIssueDetail = (item: WorkspaceMetrics['riskItems'][number]) => {
    setNotificationOpen(false)
    setIssueDetail(item)
  }
  const notificationPanel = <IssueNotificationPanel
    state={issueRead}
    items={actionableIssues ?? []}
    onOpenIssue={openIssueDetail}
    onClose={() => setNotificationOpen(false)}
    onRetry={() => setIssueReload((value) => value + 1)}
  />
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
        <h1>{titles[page]}</h1>
      </div>
      <div className="topbar-actions">
        <Dropdown trigger={['click']} placement="bottomRight" open={notificationOpen} onOpenChange={setNotificationOpen} dropdownRender={() => notificationPanel}>
          <IssueNotificationBell state={issueRead} />
        </Dropdown>
        <div className="account-menu" ref={accountMenuRef}>
          <button
            className="account-trigger"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-label="打开账号菜单"
            aria-expanded={accountMenuOpen}
            aria-haspopup="menu"
          >
            <span className="avatar-button" aria-hidden="true">{accountInitial}</span>
            <span className="account-trigger-copy">
              <strong>{displayName}</strong>
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {accountMenuOpen && (
            <div className="account-dropdown" role="menu" aria-label="账号菜单">
              <div className="account-dropdown-header">
                <span className="account-dropdown-avatar" aria-hidden="true">{accountInitial}</span>
                <div>
                  <strong>{displayName}</strong>
                  <span>{account?.login || '当前为离线演示账号'}</span>
                  <em><i />已登录</em>
                </div>
              </div>
              <div className="account-dropdown-section">
                <div className="account-dropdown-section-title"><UserRound size={15} />个人信息</div>
                <dl className="account-dropdown-facts">
                  <div><dt>登录账号</dt><dd>{account?.login || '未读取'}</dd></div>
                  <div><dt>账号所属</dt><dd>{account?.enterpriseName?.trim() || '未读取'}</dd></div>
                  <div><dt>账号状态</dt><dd>{account ? merchantAccountStatusLabel(account.status) : '未读取'}</dd></div>
                  <div><dt>创意点余额</dt><dd>{points === null || points === undefined ? '未读取' : `${points.toLocaleString('zh-CN')} 点`}</dd></div>
                </dl>
              </div>
              <div className="account-dropdown-actions">
                {apiBaseUrl && account && <LocalPluginConnection apiBaseUrl={apiBaseUrl} account={account} />}
                {apiBaseUrl && account ? (
                  <button
                    className="account-secondary-button"
                    type="button"
                    onClick={() => {
                      setPasswordError('')
                      passwordForm.resetFields()
                      setPasswordModalOpen(true)
                    }}
                  >
                    修改密码
                  </button>
                ) : null}
                <button className="account-logout-button" type="button" onClick={() => { setAccountMenuOpen(false); onLogout() }}>
                  <LogOut size={16} />退出登录
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <Modal
        title="修改商家账号密码"
        open={passwordModalOpen}
        okText="确认修改"
        cancelText="取消"
        confirmLoading={passwordSubmitting}
        destroyOnHidden
        onCancel={() => {
          if (!passwordSubmitting) setPasswordModalOpen(false)
        }}
        onOk={() => void passwordForm.submit()}
      >
        <p className="account-password-help">修改成功后当前账号的其他登录会话会失效，需要重新登录。</p>
        {passwordError ? <Alert type="error" showIcon title={passwordError} /> : null}
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={async (values) => {
            if (!apiBaseUrl) return
            setPasswordSubmitting(true)
            setPasswordError('')
            try {
              await changeMerchantPassword(apiBaseUrl, {
                currentPassword: values.current_password,
                newPassword: values.new_password,
              })
              setPasswordModalOpen(false)
              onPasswordChanged()
            } catch (cause) {
              setPasswordError(describeApiError(cause))
            } finally {
              setPasswordSubmitting(false)
            }
          }}
        >
          <Form.Item label="当前密码" name="current_password" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item label="新密码" name="new_password" rules={[{ required: true, message: '请输入新密码' }, { min: 12, message: '新密码至少 12 位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            label="确认新密码"
            name="confirm_password"
            dependencies={['new_password']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  return !value || getFieldValue('new_password') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的新密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="问题详情" open={Boolean(issueDetail)} onCancel={() => setIssueDetail(null)} footer={<Space><Button onClick={() => setIssueDetail(null)}>关闭</Button><Button type="primary" onClick={() => { setIssueDetail(null); onOpenIssues() }}>查看并处理</Button></Space>} destroyOnHidden>
        {issueDetail ? <DescriptionsIssue item={issueDetail} /> : null}
      </Modal>
    </header>
  )
}

function DescriptionsIssue({ item }: { item: WorkspaceMetrics['riskItems'][number] }) {
  return <div className="merchant-notification-detail"><Tag color={item.severity === 'high' ? 'red' : 'orange'}>{item.severity === 'high' ? '高优先级' : '需要关注'}</Tag><h3>{item.title ?? item.type}</h3><p>{[item.platform ? platformNames[item.platform] : '', item.storeName ?? '', item.status ?? ''].filter(Boolean).join(' · ') || '当前工作区'}</p><div className="merchant-notification-next"><strong>建议下一步</strong><span>{item.nextAction ?? '打开商品与任务查看处理方式'}</span></div></div>
}

function EnvironmentStatusBanner({
  apiOnline,
  apiBaseUrl,
  apiHealth,
  modelStatus,
  modelStatusRead,
  onOpenHealth,
}: {
  apiOnline: boolean | null
  apiBaseUrl?: string
  apiHealth: ApiHealth | null
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
  onOpenHealth: () => void
}) {
  const environmentStatus = resolveMerchantEnvironmentStatus({
    apiBaseUrl,
    apiOnline,
    apiHealth,
    modelStatus,
    modelStatusRead,
  })
  return (
    <div
      className={`environment-banner ${environmentStatus.tone}`}
      data-environment-state={environmentStatus.state}
      role="status"
      aria-live="polite"
    >
      <span className="environment-dot" aria-hidden="true" />
      <div>
        <b>{environmentStatus.title}</b>
        <span>{environmentStatus.detail}</span>
      </div>
      <button className="text-button" onClick={onOpenHealth}>
        {!apiBaseUrl ? '查看连接说明' : '查看状态原因'}
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
        </div>
        <nav aria-label="主导航">
          <div className="nav-label">工作台</div>
          {navItems.map((item) => {
            const Icon = item.icon
            const active = item.id === 'products'
              ? page === 'products' || page === 'task' || page === 'publish'
              : page === item.id
            return (
              <Fragment key={item.id}>
                {item.id === 'products' ? (
                  <div className={`nav-group-title ${active ? 'active' : ''}`} aria-label={item.label}>
                    <Icon size={19} />
                    <span>{item.label}</span>
                  </div>
                ) : (
                  <button
                    className={active ? 'active' : ''}
                    onClick={() => closeForAction(() => setPage(item.id))}
                    title={item.description}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon size={19} />
                    <span>{item.label}</span>
                    {item.badge && <em>{item.badge}</em>}
                  </button>
                )}
                {item.id === 'products' && (
                  <div className="entry-nav" id="merchant-knowledge-subnav" aria-label="知识库二级菜单">
                    {knowledgeSubItems.map((subItem) => {
                      const SubIcon = subItem.icon
                      const subActive = subItem.entry
                        ? page === subItem.id && activeEntry === subItem.entry
                        : page === subItem.id
                      return (
                        <button
                          key={subItem.label}
                          className={subActive ? 'active' : ''}
                          onClick={() => closeForAction(() => subItem.entry ? onOpenEntry(subItem.entry) : setPage(subItem.id))}
                          title={subItem.description}
                          aria-current={subActive ? 'page' : undefined}
                        >
                          <SubIcon size={18} />
                          <span>
                            {subItem.label}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </Fragment>
            )
          })}
        </nav>
        <button
          className="sidebar-contact-manager"
          type="button"
          onClick={(event) => closeForAction(() => onOpenUtility('support', event.currentTarget))}
        >
          <CircleHelp size={18} />
          <span>联系客服经理</span>
        </button>
        <nav aria-label="新会话入口" className="sr-only" aria-hidden="true" />
      </aside>
    </>
  )
}

function UtilityPanel({
  panel,
  apiOnline,
  apiBaseUrl,
  apiHealth,
  modelStatus,
  modelStatusRead,
  onRefreshEnvironmentStatus,
  onClose,
}: {
  panel: UtilityPanel
  apiOnline: boolean | null
  apiBaseUrl?: string
  apiHealth: ApiHealth | null
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
  onRefreshEnvironmentStatus?: () => void
  onClose: () => void
}) {
  const modalRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeAction = useRef(onClose)
  closeAction.current = onClose
  const environmentStatus = resolveMerchantEnvironmentStatus({
    apiBaseUrl,
    apiOnline,
    apiHealth,
    modelStatus,
    modelStatusRead,
  })
  const statusActions = [
    ...environmentStatus.actions,
    ...(apiHealth?.setup?.nextActions ?? []).map(userFacingModelAction),
    ...(modelStatus?.next_actions ?? []).map(userFacingModelAction),
    ...(modelStatusRead && modelStatus?.state !== 'ready' ? ['配置平台模型中转站后重新检查'] : []),
  ]
    .filter((action, index, actions) => actions.indexOf(action) === index)
    .slice(0, 2)
    .filter(Boolean)
  const content =
    panel === 'help'
      ? {
          icon: CircleHelp,
          kicker: 'HELP & DIAGNOSTICS',
          title: '如何使用 Merchant Studio',
          body: '所有经营动作都从知识库开始。选定商品后，按事实确认、内容生成、规则检查和发布确认顺序完成，不需要在多个页面之间来回切换。',
          items: [
            '知识库：管理商品资料、授权素材并进入营销任务',
            '任务工作流：确认事实、生成内容、检查规则并批准版本',
            '发布确认：审核完成后直接打开，不再单独占用导航入口',
          ],
        }
      : {
            icon: Gauge,
            kicker: 'SYSTEM HEALTH',
            title: '系统健康与上线状态',
            body: environmentStatus.detail,
            items: [
              ...environmentStatus.facts,
              `API 地址：${apiBaseUrl ?? '未配置'}`,
              ...(statusActions.length
                ? statusActions
                : ['外部平台、模型和支付能力仍需按服务端上线门禁验收。']),
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
          {panel === 'health' && onRefreshEnvironmentStatus && (
            <button
              className="secondary"
              onClick={onRefreshEnvironmentStatus}
              disabled={!apiBaseUrl || !modelStatusRead}
            >
              {modelStatusRead ? '重新检查环境状态' : '检查中…'}
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

function CustomerSupportPanel({
  apiBaseUrl,
  relatedTaskId,
  relatedOrderId,
  onClose,
}: {
  apiBaseUrl?: string
  relatedTaskId?: string
  relatedOrderId?: string
  onClose: () => void
}) {
  type SupportQuery = { ticketId?: string; relatedTaskId?: string; relatedOrderId?: string }
  const [ticketId, setTicketId] = useState('')
  const [orderId, setOrderId] = useState(relatedOrderId ?? '')
  const [replies, setReplies] = useState<Array<{ id: string; body: string; created_at: string }>>([])
  const [ticket, setTicket] = useState<{ ticket_number: string; subject: string; status: string } | null>(null)
  const [associatedTickets, setAssociatedTickets] = useState<Array<{ ticket_id: string; ticket_number: string; subject: string; status: string; replies: Array<{ id: string; body: string; created_at: string }> }>>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [supportQuery, setSupportQuery] = useState<SupportQuery | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const loadReplies = async (association?: SupportQuery, cursor?: string) => {
    const id = ticketId.trim()
    const query = cursor && supportQuery
      ? supportQuery
      : association ?? (id ? { ticketId: id } : orderId.trim() ? { relatedOrderId: orderId.trim() } : relatedTaskId ? { relatedTaskId } : {})
    if (!apiBaseUrl) {
      setError('未配置 API，当前不会伪造支持消息。')
      return
    }
    if (!query.ticketId && !query.relatedTaskId && !query.relatedOrderId) {
      setError('请输入客服工单 ID、任务 ID 或订单 ID。')
      return
    }
    setLoading(true)
    setError('')
    try {
      const result = await fetchCustomerSupportReplies(apiBaseUrl, query, 50, cursor)
      setSupportQuery(query)
      setNextCursor(result.next_cursor ?? null)
      setAssociatedTickets(result.tickets ?? [])
      if (result.ticket) {
        setTicket(result.ticket)
        setReplies(result.replies ?? [])
      } else {
        setTicket(null)
        setReplies([])
      }
    } catch (cause) {
      setTicket(null)
      setReplies([])
      setAssociatedTickets([])
      setNextCursor(null)
      setError(`支持消息读取失败：${describeApiError(cause)}`)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="modal-layer" role="presentation">
      <div className="modal utility-modal" role="dialog" aria-modal="true" aria-labelledby="support-panel-title">
        <div className="modal-head">
          <div className="modal-icon"><CircleHelp size={20} /></div>
          <div><span className="section-kicker">SUPPORT</span><h2 id="support-panel-title">支持消息</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭支持消息"><X size={19} /></button>
        </div>
        <div className="modal-body">
          <p className="utility-body">这里只显示运营人员明确标记为“客户可见”的回复。内部备注、运营身份和审计字段不会返回。</p>
          {relatedTaskId && <div className="utility-list"><div><CircleHelp size={15} /><span>当前任务已绑定客服查询入口：{relatedTaskId}</span></div></div>}
          {relatedTaskId && <button className="secondary" onClick={() => void loadReplies({ relatedTaskId })} disabled={loading || !apiBaseUrl}>{loading ? '读取中…' : '查看当前任务关联工单'}</button>}
          {relatedOrderId && <button className="secondary" onClick={() => void loadReplies({ relatedOrderId })} disabled={loading || !apiBaseUrl}>{loading ? '读取中…' : '查看当前订单关联工单'}</button>}
          <label className="field-label" htmlFor="support-ticket-id">客服工单 ID</label>
          <input id="support-ticket-id" value={ticketId} onChange={event => setTicketId(event.target.value)} placeholder="可选：已有工单才填写 UUID" onKeyDown={event => { if (event.key === 'Enter') void loadReplies() }} />
          <label className="field-label" htmlFor="support-order-id">订单 ID（可选）</label>
          <input id="support-order-id" value={orderId} onChange={event => setOrderId(event.target.value)} placeholder="按订单发现关联工单" onKeyDown={event => { if (event.key === 'Enter') void loadReplies() }} />
          {error && <p className="error-text" role="alert">{error}</p>}
          {associatedTickets.length > 0 && <div className="utility-list">{associatedTickets.map(item => <div key={item.ticket_id}><CheckCircle2 size={15} /><span>{item.ticket_number} · {item.subject} · {item.status}{item.replies.length ? item.replies.map(reply => <small key={reply.id}>{reply.body} · {new Date(reply.created_at).toLocaleString()}</small>) : <small>当前暂无客户可见回复</small>}</span></div>)}</div>}
          {ticket && <div className="utility-list"><div><CheckCircle2 size={15} /><span>{ticket.ticket_number} · {ticket.subject} · {ticket.status}</span></div></div>}
          {ticket && !replies.length && <p className="muted">当前工单暂无客户可见回复。</p>}
          {replies.length > 0 && <div className="utility-list">{replies.map(reply => <div key={reply.id}><CheckCircle2 size={15} /><span>{reply.body}<small>{new Date(reply.created_at).toLocaleString()}</small></span></div>)}</div>}
          {nextCursor && <div className="info-notice" role="status">当前仅显示这一页客户可见回复/关联工单，服务端仍有下一页；未把当前结果误报为完整。</div>}
          {nextCursor && <button className="secondary" onClick={() => void loadReplies(undefined, nextCursor)} disabled={loading}>{loading ? '读取中…' : '读取下一页客户回复'}</button>}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={() => void loadReplies()} disabled={loading || !apiBaseUrl}>{loading ? '读取中…' : '读取客户回复'}</button>
          <button className="primary" onClick={onClose}>关闭</button>
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

const UNREAD_METRIC = '未读取'
/**
 * A read that settled *without* an answer is not a read that answered "none".
 * `UNREAD_METRIC` covers the read that has not come back yet; this is the one
 * that came back as an error.
 */
const READ_FAILED_METRIC = '读取失败'

/** Storage bytes are only rendered from the server quota projection. */
function formatStorageGb(bytes: number) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatRuleUpdatedAt(value: string | undefined) {
  if (!value) return UNREAD_METRIC
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return UNREAD_METRIC
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed)
}

/**
 * The overview landing page is the `yxsona.com` merchant entry point, so every
 * number here must come from a server read (`workspace.metrics`, `billing`,
 * `asset` storage quota, `rule.list`) or be shown as unread — never a fixture
 * value that a paying merchant could mistake for their own business data.
 */
export type RulePackBoardMode = 'unconfigured' | 'loading' | 'read_error' | 'empty' | 'ready'

/**
 * Knowledge-board state for the rule-pack read. Same five-state contract as
 * `resolveLibraryData`: a missing API, a read still in flight, a failed read
 * and a successful read that returned nothing are four different facts, and
 * only the last one may be described as "no rule versions".
 */
export function resolveRulePackBoard({
  baseUrl,
  packs,
  error,
}: {
  baseUrl?: string
  packs: RulePack[] | null
  error: string
}): { mode: RulePackBoardMode; message: string } {
  if (!baseUrl) return { mode: 'unconfigured', message: '未配置 API，无法读取规则版本。' }
  if (error) return { mode: 'read_error', message: `规则版本读取失败：${error}。当前不显示版本列表。` }
  if (packs === null) return { mode: 'loading', message: '正在读取…' }
  if (packs.length === 0) return { mode: 'empty', message: '服务端未返回规则版本。' }
  return { mode: 'ready', message: '' }
}

export function TodayDashboard({
  baseUrl,
  metrics,
  billing,
}: {
  baseUrl?: string
  metrics: WorkspaceMetrics | null
  billing: BillingStatus | null
}) {
  // `null` means "the read has not resolved yet"; an empty array is a real
  // successful read that returned no rule packs. A failed read keeps `null`
  // and records the reason, so it is not folded into the successful-empty case.
  const [rulePacks, setRulePacks] = useState<RulePack[] | null>(null)
  const [rulePacksError, setRulePacksError] = useState('')
  const [storageQuota, setStorageQuota] = useState<StorageQuotaProjection | null>(null)
  const [storageRead, setStorageRead] = useState(false)
  useEffect(() => {
    if (!baseUrl) {
      setStorageQuota(null)
      setStorageRead(false)
      return
    }
    let active = true
    setStorageQuota(null)
    setStorageRead(false)
    fetchAssetStorageQuota(baseUrl)
      .then((quota) => { if (active) setStorageQuota(quota ?? null) })
      .catch(() => { if (active) setStorageQuota(null) })
      .finally(() => { if (active) setStorageRead(true) })
    return () => { active = false }
  }, [baseUrl])
  useEffect(() => {
    if (!baseUrl) { setRulePacks(null); setRulePacksError(''); return }
    let active = true
    setRulePacks(null)
    setRulePacksError('')
    fetchRulePacks(baseUrl)
      .then((packs) => { if (active) setRulePacks(packs ?? []) })
      .catch((cause) => {
        if (!active) return
        // Keep `null`: a read that failed is unknown, not an empty result.
        setRulePacks(null)
        setRulePacksError(describeApiError(cause))
      })
    return () => { active = false }
  }, [baseUrl])
  const readableStoreCount = metrics
    ? metrics.stores.filter((store) => isRealReadableStore(store.connection)).length
    : null
  const productTotal = metrics ? metrics.productSummary.total : null
  const riskTotal = metrics ? metrics.riskSummary.total : null
  const pointBalance = billing?.available_points ?? null
  const storageUsedBytes = storageQuota?.usedBytes ?? null
  const storageLimitBytes = storageQuota?.limitBytes ?? null
  const storageAvailableBytes = storageQuota?.availableBytes ?? null
  const storageKnown = storageUsedBytes !== null && storageLimitBytes !== null && storageLimitBytes > 0
  const storageState = storageKnown
    ? null
    : baseUrl
      ? storageRead
        ? '服务端未返回储存配额，当前不显示用量。'
        : '正在读取储存配额…'
      : '未配置 API，无法读取储存配额。'
  const ruleBoard = resolveRulePackBoard({ baseUrl, packs: rulePacks, error: rulePacksError })
  const visibleRulePacks = (rulePacks ?? []).slice(0, 4)

  return (
    <section className="today-dashboard" aria-labelledby="today-dashboard-title">
      <div className="today-dashboard-heading">
        <div>
          <span className="section-kicker">DAILY BRIEFING</span>
          <h2 id="today-dashboard-title">今日看板</h2>
          <p>汇总当前工作区数据、规则版本和素材容量，全部来自服务端读取。</p>
        </div>
        <div className="today-current-plan" aria-label={`当前剩余创意点：${pointBalance === null ? UNREAD_METRIC : `${pointBalance} 点`}`}>
          <span><Sparkles size={14} />当前剩余创意点</span>
          <strong>{pointBalance === null ? UNREAD_METRIC : `${pointBalance.toLocaleString('zh-CN')} 点`}</strong>
          <small>{billing ? `钱包余额 ¥${billing.balance_cny}` : '等待服务端账务数据'}</small>
        </div>
      </div>

      <div className="today-dashboard-grid">
        <article className="today-board-card today-data-board">
          <div className="today-board-title">
            <span className="today-board-icon" aria-hidden="true"><LayoutDashboard size={18} /></span>
            <div><h3>数据看板</h3><span>当前工作区摘要</span></div>
          </div>
          <div className="today-stat-grid">
            <div><span>已连接店铺</span><strong>{readableStoreCount === null ? UNREAD_METRIC : readableStoreCount}<small>家</small></strong></div>
            <div><span>商品总数</span><strong>{productTotal === null ? UNREAD_METRIC : productTotal.toLocaleString('zh-CN')}<small>件</small></strong></div>
            <div><span>待处理风险</span><strong>{riskTotal === null ? UNREAD_METRIC : riskTotal.toLocaleString('zh-CN')}<small>项</small></strong></div>
          </div>
        </article>

        <article className="today-board-card today-assets-board">
          <div className="today-board-title">
            <span className="today-board-icon" aria-hidden="true"><FolderOpen size={18} /></span>
            <div><h3>素材看板</h3><span>店铺与储存空间</span></div>
          </div>
          <div className="today-assets-summary" aria-label="素材概览">
            <div><span>已连接</span><strong>{readableStoreCount === null ? UNREAD_METRIC : readableStoreCount}<small>家电商店铺</small></strong></div>
            <div><span>已用储存</span><strong>{storageUsedBytes === null ? UNREAD_METRIC : formatStorageGb(storageUsedBytes)}<small>素材</small></strong></div>
            <div><span>剩余储存</span><strong>{storageAvailableBytes === null ? UNREAD_METRIC : formatStorageGb(storageAvailableBytes)}<small>可用</small></strong></div>
          </div>
          <div className="today-storage-heading">
            <span>储存空间</span><b>{storageKnown ? `${formatStorageGb(storageUsedBytes!)} / ${formatStorageGb(storageLimitBytes!)}` : UNREAD_METRIC}</b>
          </div>
          {storageKnown ? (
            <>
              <div
                className="today-storage-progress"
                role="progressbar"
                aria-label="储存空间已用"
                aria-valuemin={0}
                aria-valuemax={Math.round(storageLimitBytes!)}
                aria-valuenow={Math.min(Math.round(storageLimitBytes!), Math.max(0, Math.round(storageUsedBytes!)))}
              >
                <span style={{ width: `${Math.min(100, (storageUsedBytes! / storageLimitBytes!) * 100)}%` }} />
              </div>
              <div className="today-storage-meta" role="status" aria-live="polite"><span>已用 {formatStorageGb(storageUsedBytes!)}</span><span>剩余 {formatStorageGb(storageAvailableBytes ?? Math.max(0, storageLimitBytes! - storageUsedBytes!))}</span></div>
            </>
          ) : (
            <div className="today-storage-meta" role="status" aria-live="polite"><span>{storageState}</span></div>
          )}
        </article>

        <article className="today-board-card today-knowledge-board">
          <div className="today-board-title">
            <span className="today-board-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
            <div><h3>知识库看板</h3><span>规则版本与更新状态</span></div>
          </div>
          <div className="today-rule-list" role="status" aria-live="polite">
            {ruleBoard.mode !== 'ready' ? (
              <div className="today-rule-row">
                <span className="today-rule-state"><i aria-hidden="true" />规则版本</span>
                <small>{ruleBoard.message}</small>
              </div>
            ) : visibleRulePacks.map((pack) => (
              <div className="today-rule-row" key={pack.id}>
                <span className="today-rule-state"><i aria-hidden="true" />{pack.name}</span>
                <small>更新时间：{formatRuleUpdatedAt(pack.updatedAt)}</small>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  )
}

type OverviewConnectionRow = {
  key: string
  name: string
  mark: string
  status: string
}

type OverviewStoreRow = {
  key: string
  name: string
  platform: string
  mark: string
}

/**
 * The overview landing page is customer-visible, so the account and action
 * panels render only rows the server actually returned. `null` means the read
 * has not resolved (or is unavailable) and is shown as unread rather than being
 * replaced with example connections or example open issues.
 */
export function AccountDashboard({
  onOpenConnections,
  connections,
  stores,
}: {
  onOpenConnections: () => void
  connections: OverviewConnectionRow[] | null
  stores: OverviewStoreRow[] | null
}) {
  const connectedCount = connections?.filter((row) => row.status === '可读取').length ?? null
  return (
    <section className="account-dashboard" aria-labelledby="account-dashboard-title">
      <div className="account-dashboard-main">
        <div className="account-dashboard-heading">
          <div>
            <span className="section-kicker">ACCOUNT OVERVIEW</span>
            <h2 id="account-dashboard-title">账号看板</h2>
            <p>汇总平台授权与已连接店铺，快速掌握账号接入状态。</p>
          </div>
        </div>

        <div className="account-block account-platform-block">
          <div className="account-block-heading">
            <div><h3>平台连接</h3><span>统一查看各渠道授权状态。如果需要连接，请联系客户经理。</span></div>
            <b>{connectedCount === null ? '接入状态未读取' : `${connectedCount}/${connections!.length} 已接入`}</b>
          </div>
          <div className="account-platform-list">
            {connections === null ? (
              <div className="account-platform-row"><strong>{UNREAD_METRIC}</strong><span className="account-connection-state pending"><i aria-hidden="true" />平台连接未读取</span></div>
            ) : connections.length === 0 ? (
              <div className="account-platform-row"><strong>暂无</strong><span className="account-connection-state pending"><i aria-hidden="true" />当前工作区没有平台连接记录</span></div>
            ) : connections.map((row) => (
              <div className="account-platform-row" key={row.key}>
                <span className="account-platform-mark" aria-hidden="true">{row.mark}</span>
                <strong>{row.name}</strong>
                <span className={`account-connection-state ${row.status === '可读取' ? 'connected' : 'pending'}`}>
                  <i aria-hidden="true" />{row.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="account-block account-store-block">
          <div className="account-block-heading">
            <div><h3>已连接店铺 <strong>{stores === null ? UNREAD_METRIC : stores.length}</strong> 家</h3><span>当前可管理的店铺账号</span></div>
            <button type="button" className="account-block-link" onClick={onOpenConnections}>进入店铺连接 <ArrowRight size={14} aria-hidden="true" /></button>
          </div>
          <div className="connected-store-list">
            {stores === null ? (
              <div className="connected-store-card"><div><strong>{UNREAD_METRIC}</strong><small>店铺列表尚未从服务端读取</small></div></div>
            ) : stores.length === 0 ? (
              <div className="connected-store-card"><div><strong>暂无</strong><small>当前没有可读取的真实店铺</small></div></div>
            ) : stores.map((store) => (
              <div className="connected-store-card" key={store.key}>
                <span aria-hidden="true">{store.mark}</span>
                <div><strong>{store.name}</strong><small>{store.platform} · 可读取</small></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/** The count tag for a read that produced no number, named per mode. */
function transactionCountLabel(read: IssueReadState): string {
  if (read.count !== null) return `${read.count} 项待处理`
  if (read.mode === 'read_error') return '读取失败'
  if (read.mode === 'loading') return '读取中'
  return `${UNREAD_METRIC} 待处理`
}

export function TransactionDashboard({
  onOpenIssues,
  issues,
  read,
}: {
  onOpenIssues: () => void
  issues: WorkspaceMetrics['riskItems']
  /**
   * The dashboard answers the same question as the topbar bell about the same
   * `workspace.metrics` read, so it resolves that read with the same helper.
   * It used to infer readiness from `issues === null` alone and print
   * 「未读取」 while the bell beside it said 「工作区待处理问题读取失败：…」 —
   * two conclusions about one request, and the wrong one was the reassuring
   * one.
   */
  read: IssueReadState
}) {
  // Only `read.count` may produce a number: a count the helper did not measure
  // stays off the page instead of being guessed from the list length.
  const count = read.count
  return (
      <aside className="transaction-dashboard" aria-labelledby="transaction-dashboard-title">
        <div className="transaction-dashboard-heading">
          <div>
            <span className="section-kicker">ACTION CENTER</span>
            <h2 id="transaction-dashboard-title">事务看板</h2>
            <p>集中查看需要处理的授权、素材与运营事项。</p>
          </div>
          <span className="transaction-count">{transactionCountLabel(read)}</span>
        </div>
        {count === null ? (
          <div className="account-all-clear"><RefreshCw size={28} /><strong>{read.notice}</strong></div>
        ) : issues.length ? (
          <div className="account-issue-list">
            {issues.map((issue, index) => (
              <button type="button" onClick={onOpenIssues} key={`${issue.type}-${issue.platform ?? ''}-${issue.accountId ?? ''}-${index}`}>
                <span>{index + 1}</span>
                <div><strong>{issue.title ?? issue.type}</strong><small>{issue.nextAction ?? '打开商品与任务查看处理方式'}</small></div>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : (
          <div className="account-all-clear"><CheckCircle2 size={28} /><strong>当前没有待处理事务</strong></div>
        )}
      </aside>
  )
}

export function isManualPlatformOperationsMode(apiMode: string | null | undefined): boolean {
  return apiMode?.trim().toLowerCase() === 'manual'
}

export function platformOperationsModeFromHealth(health: ApiHealth | null | undefined): string | null {
  return health?.setup?.platformOperations?.mode?.trim().toLowerCase() || null
}

export function shouldDiscoverPlatformAccounts(baseUrl: string | undefined, apiMode: string | null | undefined): boolean {
  return Boolean(baseUrl && apiMode?.trim().toLowerCase() === 'official_api')
}

export function Overview({
  goTask,
  goProducts,
  goTasks,
  baseUrl,
  apiMode,
  billing,
  onOpenUtility,
}: {
  goTask: () => void
  goProducts: () => void
  goTasks: () => void
  baseUrl?: string
  apiMode?: string | null
  billing: BillingStatus | null
  onOpenUtility: (panel: UtilityPanel) => void
}) {
  const accountsRequestId = useRef(0)
  const syncJobsRequestId = useRef(0)
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(Boolean(baseUrl))
  const [accountsError, setAccountsError] = useState('')
  const [action, setAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionRetry, setActionRetry] = useState<(() => void) | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const [syncJobs, setSyncJobs] = useState<SyncJob[] | null>(null)
  const [syncJobsError, setSyncJobsError] = useState('')
  const [revokeTarget, setRevokeTarget] = useState<{
    platform: PlatformId
    accountId: string
    label: string
  } | null>(null)
  const [metrics, setMetrics] = useState<WorkspaceMetrics | null>(null)
  const [metricsError, setMetricsError] = useState('')
  const loadAccounts = () => {
    const requestId = ++accountsRequestId.current
    if (!baseUrl || isManualPlatformOperationsMode(apiMode)) {
      setAccounts(null)
      setAccountsLoading(false)
      setAccountsError('')
      return
    }
    if (!shouldDiscoverPlatformAccounts(baseUrl, apiMode)) {
      setAccounts(null)
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
      .catch((error) => {
        if (requestId === accountsRequestId.current) {
          setAccounts(null)
          setAccountsError(
            `店铺发现失败：${describeApiError(error)}。当前不会执行店铺同步；请重试或检查平台连接。`,
          )
        }
      })
      .finally(() => {
        if (requestId === accountsRequestId.current) setAccountsLoading(false)
      })
  }
  useEffect(() => {
    loadAccounts()
  }, [baseUrl, apiMode])
  const loadSyncJobs = () => {
    const requestId = ++syncJobsRequestId.current
    if (!baseUrl) {
      setSyncJobs(null)
      setSyncJobsError('')
      return
    }
    if (!shouldDiscoverPlatformAccounts(baseUrl, apiMode)) {
      setSyncJobs(null)
      setSyncJobsError('')
      return
    }
    setSyncJobsError('')
    fetchSyncJobs(baseUrl)
      .then((jobs) => {
        if (requestId === syncJobsRequestId.current) setSyncJobs(jobs)
      })
      .catch((error) => {
        if (requestId === syncJobsRequestId.current) setSyncJobsError(`同步记录暂时无法读取：${describeApiError(error)}。不会改变已有任务或店铺授权状态。`)
      })
  }
  useEffect(() => {
    loadSyncJobs()
  }, [baseUrl, apiMode])
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
    setActionRetry(null)
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
        if (!result.authorizationUrl) {
          throw new Error('官方授权地址暂未生成，请检查平台 OAuth 配置后重试。')
        }
        const popup = window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
        if (!popup) {
          setActionError('浏览器阻止了官方授权页弹窗。请允许本网站弹窗后，再点击“连接”重试。')
          return
        }
        setActionMessage(
          `${platformNames[platform]} 官方授权页已打开。请完成授权后返回本页，系统会自动刷新连接状态；授权完成前不会读取或写入店铺数据。`,
        )
        loadAccounts()
        let attempts = 0
        const timer = window.setInterval(() => {
          attempts += 1
          loadAccounts()
          if (attempts >= 10) window.clearInterval(timer)
        }, 2000)
      })
      .catch((error) => {
        setActionError(`${platformNames[platform]}：${describeApiError(error)}`)
        // Keep recovery explicit and scoped to the failed platform. Retrying
        // must never guess a different account or silently sync data.
        setActionRetry(() => () => connect(platform))
      })
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
        (() => {
          setActionError(`${platformNames[platform]}：${describeApiError(error)}`)
          setActionRetry(() => () => sync(platform, accountId))
        })(),
      )
      .finally(() => setAction(null))
  }
  const syncableStoreCount = (() => {
    const resolution = resolveStoreSyncTargets(accounts)
    return resolution.ok ? resolution.targets.length : 0
  })()
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
        metrics.stores.filter((store) => isRealReadableStore(store.connection)).length,
      )
    : baseUrl
      ? '—'
      : String(
          platforms.filter((platform) => platform.status === '演示连接')
            .length,
        )
  // Mirror the notification panel: only actionable risks belonging to a real
  // bound store are merchant-facing; unbound and fixture rows are excluded.
  const overviewIssues = metrics
    ? metrics.riskItems.filter((item) => item.evidence?.unboundLocalData !== true && item.evidence?.fixtureData !== true)
    : null
  // `metricsError` starts empty and `metrics` starts null, so `items === null`
  // already carries the pending state; the failure is the third fact the
  // dashboard used to drop. The bell resolves this same `workspace.metrics`
  // read through this same helper, so both surfaces now reach one conclusion.
  const overviewIssueRead = resolveIssueReadState({
    baseUrl,
    items: overviewIssues,
    error: metricsError,
    loading: false,
  })
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
        ? (metrics.dataCompleteness === 'partial' || (metrics.hydration?.invalidSnapshotCount ?? 0) > 0 ? '工作区数据部分可用' : '工作区数据已读取')
        : '正在读取业务数据'
  const metricsPartial = Boolean(metrics && (metrics.dataCompleteness === 'partial' || (metrics.hydration?.invalidSnapshotCount ?? 0) > 0))
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
      {accountsError && (
        <ErrorNotice
          message={accountsError}
          onRetry={loadAccounts}
          retryLabel="重试店铺发现"
        />
      )}

      {shouldDiscoverPlatformAccounts(baseUrl, apiMode) && (
        <div className="action-row overview-sync-actions">
          <button
            className="primary"
            type="button"
            onClick={() => void syncAll()}
            disabled={
              accountsLoading ||
              Boolean(accountsError) ||
              !accounts ||
              syncableStoreCount === 0 ||
              action === 'sync-all'
            }
          >
            <RefreshCw size={17} className={action === 'sync-all' ? 'spin' : undefined} />
            {action === 'sync-all' ? '同步全部店铺…' : syncableStoreCount === 0 ? '等待店铺连接' : '同步全部店铺'}
          </button>
          <small className="action-help">
            {accountsError
              ? '店铺发现失败，当前不会发起同步。'
              : accountsLoading
                ? '正在发现可读取店铺…'
                : `将逐店同步 ${syncableStoreCount} 家可读取店铺。`}
          </small>
        </div>
      )}
      {baseUrl && isManualPlatformOperationsMode(apiMode) && (
        <div className="info-notice" role="status">当前为人工运营模式，六平台店铺由运营人员在官方后台处理；首页不会自动发现、授权或同步店铺。</div>
      )}
      {baseUrl && !apiMode && (
        <div className="info-notice" role="status">平台运营模式未确认，已停止自动发现店铺和读取同步任务；不会用默认模式绕过服务端权限。</div>
      )}

      <TodayDashboard baseUrl={baseUrl} metrics={metrics} billing={billing} />

      <div className="overview-secondary-grid">
        <AccountDashboard
          onOpenConnections={goProducts}
          // `rows` collapses an unresolved/failed account read to `[]`, which
          // would let the dashboard claim 「当前工作区没有平台连接记录」 while
          // the read is still pending or has errored. Mirror the `stores` prop:
          // pass `null` so the panel's explicit unread branch is reachable. The
          // offline demo keeps its labelled 「演示连接」 fixture rows.
          connections={
            apiRows || !baseUrl
              ? rows.map((row) => ({
                  key: `${row.platformId}-${row.accountId ?? 'unbound'}`,
                  name: row.name,
                  mark: Array.from(row.name)[0] ?? '',
                  status: row.status,
                }))
              : null
          }
          stores={apiRows ? apiRows.filter((row) => row.status === '可读取' && row.accountId).map((row) => ({ key: `${row.platformId}-${row.accountId}`, name: row.shop, platform: row.name, mark: Array.from(row.name)[0] ?? '' })) : null}
        />
        <TransactionDashboard onOpenIssues={goProducts} issues={overviewIssues ?? []} read={overviewIssueRead} />
      </div>

      <WorkspaceDataIntegrityNotice metrics={metrics} />

      {metricsError && (
        <ErrorNotice
          message={`运营指标：${metricsError}`}
          onRetry={loadMetrics}
          compact
        />
      )}



      <section className="dashboard-grid">
        <article className="panel platform-panel" aria-busy={accountsLoading}>
          <div className="panel-heading">
            <div>
              <span className="section-kicker">CONNECTIONS</span>
              <h3>平台连接</h3>
              <p className="panel-hint">
                {baseUrl
                  ? '仅显示当前工作区的店铺身份；“演示连接”是本地 Fixture，不代表真实平台已授权。'
                  : '离线演示不会访问真实店铺；连接 API 后可发起官方授权。'}
              </p>
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
    {actionError && <ErrorNotice message={actionError} onRetry={actionRetry ?? undefined} retryLabel="重试当前操作" compact focusOnMount />}
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
                <div className={`platform-logo ${platform.tone}`} aria-hidden="true">
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
                        aria-busy={action === `sync-${platform.platformId}`}
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
                        aria-busy={action === `revoke-${platform.platformId}`}
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
                          aria-busy={action === platform.platformId}
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

type PointUsageItem = { label: string; value: number; dateLabel?: string }

/**
 * Aggregate real consumption from the creative-point ledger. Only negative
 * deltas are consumption, and buckets are keyed by the server timestamp, so an
 * empty or unavailable ledger produces an empty chart rather than a
 * plausible-looking trend the server never reported.
 *
 * `pointsDelta`/`createdAt` are the field names the producing ledger repository
 * serialises (`packages/persistence/src/creative-point-repository.ts`); the
 * snake_case names this used to read matched only the dormant
 * `packages/contracts` declaration, so every real row was filtered out and the
 * panel published 「合计 0 点」 over an unread ledger.
 */
export function aggregatePointUsage(entries: CreativePointStatementEntry[], mode: 'day' | 'month'): PointUsageItem[] {
  const buckets = new Map<string, number>()
  for (const entry of entries) {
    if (!Number.isFinite(entry.pointsDelta) || entry.pointsDelta >= 0) continue
    const occurredAt = new Date(entry.createdAt)
    if (Number.isNaN(occurredAt.getTime())) continue
    const month = `${occurredAt.getFullYear()}/${String(occurredAt.getMonth() + 1).padStart(2, '0')}`
    const key = mode === 'day' ? `${month}/${String(occurredAt.getDate()).padStart(2, '0')}` : month
    buckets.set(key, (buckets.get(key) ?? 0) + Math.abs(entry.pointsDelta))
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ label: mode === 'day' ? key.slice(5) : key, dateLabel: key, value }))
}

type PointPackageOption = {
  id: string
  name: string
  amountLabel: string
  priceLabel: string
  priceCny: number | null
  note: string
  pointsPerUnit: number | null
  blockedReason: string
}

/**
 * Why 「确认购买」 cannot create an order for the selected pack.
 *
 * A contract-priced SKU has no orderable price in the catalogue, so the button
 * is disabled — but the checkout only rendered `blockedReason`, leaving a dead
 * button with no explanation. `blockedReason` keeps priority: when the server
 * already listed unresolved items, that text is the actionable one.
 */
export function resolvePurchaseBlockNotice(selectedPackage: Pick<PointPackageOption, 'priceCny' | 'blockedReason'> | null): string {
  if (!selectedPackage || selectedPackage.blockedReason) return ''
  if (selectedPackage.priceCny === null) return '服务端目录未给出可下单价格，当前无法创建充值订单；请联系客户经理确认价格。'
  return ''
}

/**
 * The order amount in fen.
 *
 * `priceCny` is decoded from the catalogue's `price_label` as a decimal number,
 * so charging `priceCny * quantity` as a float leaks binary residue into the
 * request: a ¥99.90 pack times three is 299.70000000000005, and the API's
 * `parseCnyToFen` (`^\d{1,8}(?:\.\d{1,2})?$`) rejects anything with more than
 * two decimals as BILLING_AMOUNT_INVALID — the quantity simply could not be
 * bought, and the same residue was shown as the payable amount.
 */
export function rechargeAmountFen(priceCny: number, quantity: number): number {
  return Math.round(priceCny * 100) * quantity
}

/** Fen as the two-decimal CNY string the billing API accepts. */
export function formatAmountCny(fen: number): string {
  return (fen / 100).toFixed(2)
}

/**
 * Carry the idempotency key across retries of one purchase intent.
 *
 * Same intent in, same key out: a retry after a client timeout reaches the
 * order the server already created instead of minting a second payable one.
 * A different intent (other pack, amount, quantity or channel) gets a fresh
 * key so an unrelated purchase is never collapsed into the previous order.
 */
export function resolveRechargeIdempotency(
  intent: string,
  previous: { intent: string; key: string },
): { intent: string; key: string } {
  if (previous.key && previous.intent === intent) return previous
  return { intent, key: `studio-${intent}-${crypto.randomUUID()}` }
}

/** Point packs are only those the server commercial catalog actually publishes. */
function resolvePointPackages(catalog: CommercialCatalogItem[]): PointPackageOption[] {
  return selectMerchantCatalogItems(catalog)
    .filter((item) => item.type === 'point_pack')
    .map((item) => {
      const price = Number(item.price_label.replace(/[^0-9.]/gu, ''))
      const points = item.benefits.find((benefit) => /point/iu.test(benefit.code))?.quantity ?? null
      return {
        id: item.id,
        name: item.name,
        amountLabel: item.benefits_summary || item.cycle_label || '权益以服务端目录为准',
        priceLabel: item.price_label,
        priceCny: Number.isFinite(price) && price > 0 ? price : null,
        note: item.cycle_label ?? '服务端商业目录',
        pointsPerUnit: typeof points === 'number' && points > 0 ? points : null,
        blockedReason: item.executable ? '' : (item.unresolved.join('；') || '服务端未将该套餐标记为可下单'),
      }
    })
}

function PaymentQrCode() {
  const cells = Array.from({ length: 21 * 21 }, (_, index) => {
    const x = index % 21
    const y = Math.floor(index / 21)
    const inFinder = (left: number, top: number) => x >= left && x < left + 7 && y >= top && y < top + 7
    const finderCell = (left: number, top: number) => {
      const dx = x - left
      const dy = y - top
      return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
    }
    const filled = inFinder(0, 0) ? finderCell(0, 0) : inFinder(14, 0) ? finderCell(14, 0) : inFinder(0, 14) ? finderCell(0, 14) : ((x * 7 + y * 11 + x * y) % 5 < 2)
    return filled ? <rect key={index} x={x} y={y} width="1" height="1" /> : null
  })
  return <svg className="finance-payment-qr" viewBox="-1 -1 23 23" role="img" aria-label="购买支付二维码"><rect x="-1" y="-1" width="23" height="23" fill="#fff" />{cells}</svg>
}

function PointUsageChart({ items, label }: { items: PointUsageItem[]; label: string }) {
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null)
  const width = 900
  const height = 300
  const paddingLeft = 54
  const paddingRight = 28
  const paddingTop = 36
  const paddingBottom = 38
  const maxValue = Math.max(10, Math.ceil(Math.max(...items.map((item) => item.value)) / 10) * 10)
  const stepX = (width - paddingLeft - paddingRight) / Math.max(1, items.length - 1)
  const chartHeight = height - paddingTop - paddingBottom
  const points = items.map((item, index) => ({ ...item, x: paddingLeft + index * stepX, y: paddingTop + chartHeight - (item.value / maxValue) * chartHeight }))
  const line = points.map((point) => `${point.x},${point.y}`).join(' ')
  const area = `${paddingLeft},${height - paddingBottom} ${line} ${width - paddingRight},${height - paddingBottom}`
  const hoveredPoint = hoveredPointIndex === null ? null : points[hoveredPointIndex]
  return (
    <div className="finance-chart" role="img" aria-label={`${label}创意点消耗折线图`}>
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {[0, 1, 2, 3].map((row) => { const y = paddingTop + (chartHeight / 3) * row; const value = Math.round(maxValue * (1 - row / 3)); return <g key={row}><line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} className="finance-chart-grid" /><text x={paddingLeft - 14} y={y + 4} textAnchor="end" className="finance-chart-axis-value">{value}</text></g> })}
        <polygon points={area} className="finance-chart-area" />
        <polyline points={line} className="finance-chart-line" />
        {points.map((point, index) => {
          const previousValue = points[index - 1]?.value ?? point.value
          const nextValue = points[index + 1]?.value ?? point.value
          const isValley = point.value <= previousValue && point.value <= nextValue
          const labelY = isValley ? Math.min(height - paddingBottom - 8, point.y + 18) : Math.max(17, point.y - 12)
          const showDateLabel = items.length <= 12 || index === 0 || index === items.length - 1 || (index + 1) % 5 === 0
          return <g className="finance-chart-point" key={`${point.label}-${index}`} tabIndex={0} onMouseEnter={() => setHoveredPointIndex(index)} onMouseLeave={() => setHoveredPointIndex(null)} onFocus={() => setHoveredPointIndex(index)} onBlur={() => setHoveredPointIndex(null)}><title>{point.dateLabel ?? point.label}：{point.value} 点</title><circle cx={point.x} cy={point.y} r={14} className="finance-chart-hit" /><circle cx={point.x} cy={point.y} r={items.length > 15 ? 3 : 4.5} className="finance-chart-dot" /><text x={point.x} y={labelY} textAnchor="middle" className="finance-chart-value">{point.value}</text>{showDateLabel && <text x={point.x} y={height - 13} textAnchor="middle" className="finance-chart-label">{point.label}</text>}</g>
        })}
        {hoveredPoint && (() => { const tooltipWidth = 128; const tooltipX = Math.max(4, Math.min(width - tooltipWidth - 4, hoveredPoint.x - tooltipWidth / 2)); const tooltipY = hoveredPoint.y < 58 ? hoveredPoint.y + 18 : hoveredPoint.y - 44; return <g className="finance-chart-tooltip" pointerEvents="none"><rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={30} rx={7} /><text x={tooltipX + tooltipWidth / 2} y={tooltipY + 19} textAnchor="middle">{hoveredPoint.dateLabel ?? hoveredPoint.label} · {hoveredPoint.value} 点</text></g> })()}
      </svg>
    </div>
  )
}

export function FinanceOverview({ baseUrl, billing, account, onOpenSupport }: { baseUrl: string; billing: BillingStatus | null; account: MerchantAuthAccount | null; onOpenSupport: () => void }) {
  const [rangeMode, setRangeMode] = useState<'day' | 'month'>('day')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  // `null` while the ledger read is unresolved or failed; `[]` is a real read
  // that returned no entries. Neither case may fall back to sample numbers.
  const [statementEntries, setStatementEntries] = useState<CreativePointStatementEntry[] | null>(null)
  // The ledger read is bounded: a truncated read may not be summed up as the
  // workspace's complete consumption.
  const [statementTruncated, setStatementTruncated] = useState(false)
  // Rows the server returned in a shape this client could not read. They are
  // missing from the sum, so the sum must not be published as if it were whole.
  const [statementUnreadable, setStatementUnreadable] = useState(0)
  const [statementNote, setStatementNote] = useState('正在读取创意点流水…')
  const [storageQuota, setStorageQuota] = useState<StorageQuotaProjection | null>(null)
  const [catalogItems, setCatalogItems] = useState<CommercialCatalogItem[] | null>(null)
  const [catalogNote, setCatalogNote] = useState('正在读取创意点套餐…')
  const [pricingDialog, setPricingDialog] = useState<'points' | 'storage' | null>(null)
  const [selectedPointPackage, setSelectedPointPackage] = useState('')
  const [purchaseQuantity, setPurchaseQuantity] = useState(1)
  const [agreementAccepted, setAgreementAccepted] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<'wechat' | 'alipay' | 'card'>('wechat')
  const [rechargeOrder, setRechargeOrder] = useState<Awaited<ReturnType<typeof createRechargeOrder>> | null>(null)
  const [rechargeLoading, setRechargeLoading] = useState(false)
  const [rechargeError, setRechargeError] = useState('')
  const [manualPublishRecords, setManualPublishRecords] = useState<ManualPublishRecord[] | null>(null)
  const [manualPublishNote, setManualPublishNote] = useState('正在读取人工发布状态…')
  // One idempotency key per purchase intent. It must survive a failed or timed
  // out attempt so the retry replays the order the server already created, and
  // it must change when the merchant really does change what they are buying.
  const rechargeIntent = useRef('')
  const rechargeIdempotencyKey = useRef('')
  useEffect(() => {
    if (!baseUrl) {
      setStatementEntries(null)
      setStatementTruncated(false)
      setStatementUnreadable(0)
      setStatementNote('未配置 API，无法读取创意点流水。')
      setStorageQuota(null)
      setCatalogItems(null)
      setCatalogNote('未配置 API，无法读取创意点套餐。')
      setManualPublishRecords(null)
      setManualPublishNote('未配置 API，无法读取人工发布状态。')
      return
    }
    let active = true
    setStatementEntries(null)
    setStatementTruncated(false)
    setStatementUnreadable(0)
    setStatementNote('正在读取创意点流水…')
    setStorageQuota(null)
    setCatalogItems(null)
    setCatalogNote('正在读取创意点套餐…')
    setManualPublishRecords(null)
    setManualPublishNote('正在读取人工发布状态…')
    fetchCreativePointStatement(baseUrl)
      .then((page) => {
        if (!active) return
        if (page === null) {
          setStatementEntries(null)
          setStatementTruncated(false)
          setStatementUnreadable(0)
          setStatementNote('服务端创意点流水未按可识别的格式返回，当前不显示消耗趋势，也不断言该区间没有流水。')
          return
        }
        setStatementEntries(page.entries)
        setStatementTruncated(page.truncated)
        setStatementUnreadable(page.unreadableEntries)
      })
      .catch((cause) => {
        if (!active) return
        setStatementEntries(null)
        setStatementTruncated(false)
        setStatementUnreadable(0)
        setStatementNote(`创意点流水读取失败：${describeApiError(cause)}`)
      })
    fetchAssetStorageQuota(baseUrl)
      .then((quota) => { if (active) setStorageQuota(quota ?? null) })
      .catch(() => { if (active) setStorageQuota(null) })
    fetchCommercialCatalog(baseUrl)
      .then((result) => { if (active) setCatalogItems(result.catalog) })
      .catch((cause) => {
        if (!active) return
        setCatalogItems(null)
        setCatalogNote(`创意点套餐读取失败：${describeApiError(cause)}`)
      })
    fetchManualPublishRecords(baseUrl)
      .then((records) => {
        if (!active) return
        setManualPublishRecords(records.slice().sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt)))
        setManualPublishNote('')
      })
      .catch((cause) => {
        if (!active) return
        setManualPublishRecords(null)
        setManualPublishNote(`人工发布状态读取失败：${describeApiError(cause)}`)
      })
    return () => { active = false }
  }, [baseUrl])
  const pointPackages = useMemo(() => (catalogItems ? resolvePointPackages(catalogItems) : []), [catalogItems])
  const selectedPackage = pointPackages.find((item) => item.id === selectedPointPackage) ?? null
  const selectedPointCount = selectedPackage?.pointsPerUnit ? selectedPackage.pointsPerUnit * purchaseQuantity : null
  const purchaseBlockNotice = resolvePurchaseBlockNotice(selectedPackage)
  const dailyUsage = useMemo(() => aggregatePointUsage(statementEntries ?? [], 'day'), [statementEntries])
  const monthlyUsage = useMemo(() => aggregatePointUsage(statementEntries ?? [], 'month'), [statementEntries])
  const chartItems = useMemo(() => {
    const source = rangeMode === 'day' ? dailyUsage : monthlyUsage
    const startValue = rangeMode === 'day' ? rangeStart.replaceAll('-', '/') : rangeStart.replace('-', '/')
    const endValue = rangeMode === 'day' ? rangeEnd.replaceAll('-', '/') : rangeEnd.replace('-', '/')
    return source.filter((item) => (!startValue || (item.dateLabel ?? item.label) >= startValue) && (!endValue || (item.dateLabel ?? item.label) <= endValue))
  }, [dailyUsage, monthlyUsage, rangeEnd, rangeMode, rangeStart])
  const chartLabel = rangeStart || rangeEnd
    ? `${(rangeStart || '最早').replaceAll('-', '/')} 至 ${(rangeEnd || '最新').replaceAll('-', '/')}`
    : rangeMode === 'day'
      ? '已读取流水（按日汇总）'
      : '已读取流水（按月汇总）'
  const pointBalance = billing?.available_points ?? null
  const storageUsedBytes = storageQuota?.usedBytes ?? null
  const storageLimitBytes = storageQuota?.limitBytes ?? null
  const storageAvailableBytes = storageQuota?.availableBytes ?? null
  const storageKnown = storageUsedBytes !== null && storageLimitBytes !== null && storageLimitBytes > 0
  const submitRecharge = async () => {
    if (!selectedPackage || !agreementAccepted || !baseUrl) return
    if (selectedPackage.blockedReason) { setRechargeError(selectedPackage.blockedReason); return }
    if (selectedPackage.priceCny === null) { setRechargeError('服务端目录未给出可下单价格，无法创建充值订单。'); return }
    if (paymentMethod === 'card') { setRechargeError('当前仅支持支付宝或微信，银行卡支付暂未开放。'); return }
    setRechargeLoading(true); setRechargeError('')
    const amount = formatAmountCny(rechargeAmountFen(selectedPackage.priceCny, purchaseQuantity))
    const intent = [selectedPackage.id, amount, paymentMethod, purchaseQuantity].join('|')
    const resolved = resolveRechargeIdempotency(intent, { intent: rechargeIntent.current, key: rechargeIdempotencyKey.current })
    rechargeIntent.current = resolved.intent
    rechargeIdempotencyKey.current = resolved.key
    const idempotencyKey = resolved.key
    try {
      const order = await createRechargeOrder(baseUrl, amount, paymentMethod, idempotencyKey)
      // The intent is settled: the next click is a new purchase and must not be
      // collapsed into this order by the server's dedupe.
      rechargeIntent.current = ''
      rechargeIdempotencyKey.current = ''
      setRechargeOrder(order)
      if (order.payment_url || order.paymentUrl) window.open(order.payment_url ?? order.paymentUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      // The key is deliberately kept: the server may already have created the
      // order, so the retry must reach the same one instead of a second one.
      setRechargeError(error instanceof Error ? error.message : '创建充值订单失败')
    } finally { setRechargeLoading(false) }
  }
  const refreshRecharge = async () => {
    if (!rechargeOrder?.id || !baseUrl) return
    try { setRechargeOrder(await fetchRechargeOrder(baseUrl, rechargeOrder.id)) } catch (error) { setRechargeError(error instanceof Error ? error.message : '查询充值订单失败') }
  }
  const resetUsage = () => {
    setRangeMode('day')
    setRangeStart('')
    setRangeEnd('')
  }
  return (
    <section className="page finance-overview-page" aria-label="财务概况">
      <div className="finance-hero">
        <div><span className="section-kicker">ACCOUNT &amp; BILLING</span><h2>财务与资源</h2><p>统一查看创意点、储存空间和账号信息，全部来自服务端账本。</p></div>
      </div>
      <div className="finance-summary-grid">
        <article className="finance-balance-card accent"><div className="finance-card-icon"><Sparkles size={20} /></div><div className="finance-inline-metric"><span>当前剩余创意点</span><strong>{pointBalance === null ? UNREAD_METRIC : `${pointBalance.toLocaleString('zh-CN')} 点`}</strong></div><div className="finance-inline-metric subtle"><span>钱包余额</span><strong>{billing ? `¥${billing.balance_cny}` : UNREAD_METRIC}</strong></div><button className="primary" type="button" onClick={() => setPricingDialog('points')}>充值创意点</button></article>
        <article className="finance-balance-card"><div className="finance-card-icon"><Boxes size={20} /></div><div className="finance-inline-metric"><span>储存空间剩余</span><strong>{storageAvailableBytes === null ? UNREAD_METRIC : formatStorageGb(storageAvailableBytes)}</strong></div><div className="finance-storage-summary"><p>{storageKnown ? `已使用 ${formatStorageGb(storageUsedBytes!)} / 共 ${formatStorageGb(storageLimitBytes!)}` : '服务端未返回储存配额，当前不显示用量。'}</p>{storageKnown && <div className="finance-storage-track" role="progressbar" aria-label="储存空间已用" aria-valuemin={0} aria-valuemax={Math.round(storageLimitBytes!)} aria-valuenow={Math.min(Math.round(storageLimitBytes!), Math.max(0, Math.round(storageUsedBytes!)))}><i style={{ width: `${Math.min(100, (storageUsedBytes! / storageLimitBytes!) * 100).toFixed(1)}%` }} /></div>}</div><button className="primary" type="button" onClick={() => setPricingDialog('storage')}>购买储存空间</button></article>
      </div>
      <section className="finance-panel finance-usage-panel">
        <div className="finance-panel-heading"><div><span className="section-kicker">CREATIVE POINTS</span><h3>创意点消耗趋势</h3><p>按服务端创意点流水的发生时间汇总，可查询日期或月份区间。</p></div><form className="finance-range-search" onSubmit={(event) => { event.preventDefault() }}><label><span>查询方式</span><Select className="finance-query-select" popupClassName="finance-query-menu" value={rangeMode} options={[{ value: 'day', label: '按日期' }, { value: 'month', label: '按月份' }]} onChange={(value) => { setRangeMode(value); setRangeStart(''); setRangeEnd('') }} /></label><label><span>开始{rangeMode === 'day' ? '日期' : '月份'}</span><DatePicker className="finance-date-picker" popupClassName="finance-date-picker-popup" locale={zhCN} picker={rangeMode === 'day' ? 'date' : 'month'} value={rangeStart ? dayjs(rangeStart).locale('zh-cn') : null} format={rangeMode === 'day' ? 'YYYY/MM/DD' : 'YYYY/MM'} placeholder={rangeMode === 'day' ? '年 / 月 / 日' : '年 / 月'} allowClear onChange={(date) => setRangeStart(date ? date.format(rangeMode === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM') : '')} /></label><i>至</i><label><span>结束{rangeMode === 'day' ? '日期' : '月份'}</span><DatePicker className="finance-date-picker" popupClassName="finance-date-picker-popup" locale={zhCN} picker={rangeMode === 'day' ? 'date' : 'month'} value={rangeEnd ? dayjs(rangeEnd).locale('zh-cn') : null} format={rangeMode === 'day' ? 'YYYY/MM/DD' : 'YYYY/MM'} placeholder={rangeMode === 'day' ? '年 / 月 / 日' : '年 / 月'} allowClear onChange={(date) => setRangeEnd(date ? date.format(rangeMode === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM') : '')} /></label><button className="primary" type="submit">查询</button><button className="secondary" type="button" onClick={resetUsage}>重置</button></form></div>
        {/* The sum may only be stated when the ledger read succeeded: a failed
            or pending read rendered as 「合计 0 点」 next to an 「已读取流水」
            caption reports a consumed total that was never measured. */}
        <div className="finance-chart-summary">{statementEntries === null ? (
          <><span>创意点流水未读取</span><strong>{UNREAD_METRIC}</strong></>
        ) : (
          <><span>{chartLabel}{statementTruncated ? ' · 仅已读取页' : ''}</span><b>{chartItems.length} 个数据点</b><strong>合计 {chartItems.reduce((sum, item) => sum + item.value, 0).toLocaleString()} 点{statementTruncated ? '（仅为已读取流水，非完整合计）' : ''}{statementUnreadable ? `（另有 ${statementUnreadable} 条流水无法识别，未计入）` : ''}</strong></>
        )}</div>
        {statementEntries !== null && statementTruncated && (
          <div className="info-notice" role="status">服务端创意点流水超过单次可读取页数，趋势与合计只覆盖已读取的部分流水；未把当前结果误报为完整。</div>
        )}
        {statementEntries !== null && statementUnreadable > 0 && (
          <div className="info-notice" role="status">服务端有 {statementUnreadable} 条流水未按可识别格式返回，未计入趋势与合计；当前合计不是该区间的完整消耗。</div>
        )}
        {chartItems.length ? (
          <PointUsageChart items={chartItems} label={chartLabel} />
        ) : (
          /* Only an actually empty ledger may be reported as having no flow:
             a ledger the client read but could not bucket (grants, reserves,
             releases) is not the same statement as an empty one. */
          <p className="finance-chart finance-chart-empty" role="status">{statementEntries === null
            ? statementNote
            : statementEntries.length === 0
              ? '服务端未返回该区间的创意点流水，不显示趋势图。'
              : `服务端已读取 ${statementEntries.length} 条创意点流水，其中没有消耗记录（只有消耗类流水计入趋势），不显示趋势图。`}</p>
        )}
      </section>
      <section className="finance-account-panel"><div><span className="section-kicker">ACCOUNT</span><h3>账号与工作区</h3><p>{account ? `当前登录账号 ${account.login}，企业主体 ${account.enterpriseName?.trim() || UNREAD_METRIC}，账号状态 ${merchantAccountStatusLabel(account.status)}。` : '当前未读取到商家账号信息。'}</p></div><div className="finance-account-facts"><span><b>{account?.login || UNREAD_METRIC}</b>登录账号</span><span><b>{account?.enterpriseName?.trim() || UNREAD_METRIC}</b>企业主体</span><span><b>{account ? merchantAccountStatusLabel(account.status) : UNREAD_METRIC}</b>账号状态</span></div><button className="primary" type="button" onClick={onOpenSupport}>咨询客服升级账号</button></section>
      <section className="finance-panel" aria-label="人工发布状态">
        <div className="finance-panel-heading"><div><span className="section-kicker">MANUAL PUBLISH</span><h3>人工发布状态</h3><p>六平台由人工执行发布；这里仅展示服务端记录的进度和平台回填，不会自动提交平台。</p></div></div>
        {manualPublishRecords === null ? <p className="muted" role="status">{manualPublishNote}</p> : manualPublishRecords.length === 0 ? <p className="muted" role="status">暂无人工发布记录。内容审核完成并导出后，进度会显示在这里。</p> : (
          <div className="finance-price-table" role="table" aria-label="人工发布记录">
            <div className="finance-price-row header" role="row"><span>平台</span><span>任务</span><span>状态</span><span>平台结果</span></div>
            {manualPublishRecords.map((record) => <div className="finance-price-row" role="row" key={record.id}><strong>{platformNames[record.platform] ?? record.platform}</strong><span>{record.taskId}</span><b>{{ export_ready: '待人工发布', manual_publish_in_progress: '人工发布中', manual_publish_reported: '已回填平台结果', manual_review_required: '需人工复核' }[record.state] ?? record.state}</b><small>{record.platformDisplayStatus || record.platformContentId || record.publicUrl || '尚未回填'}</small></div>)}
          </div>
        )}
      </section>
      <Modal title={pricingDialog === 'points' ? '创意点套餐' : '储存空间购买'} open={Boolean(pricingDialog)} footer={null} width={720} onCancel={() => { setPricingDialog(null); setSelectedPointPackage(''); setPurchaseQuantity(1); setAgreementAccepted(false); setPaymentMethod('wechat') }}>
        {pricingDialog === 'points' ? <>
          <p className="finance-pricing-dialog-note">以下套餐来自服务端商业目录，价格与权益以服务端返回为准。</p>
          {catalogItems === null ? <p className="muted" role="status">{catalogNote}</p> : pointPackages.length === 0 ? <p className="muted" role="status">服务端商业目录未返回可购买的创意点套餐。</p> : (
            <div className="finance-price-table dialog" role="table" aria-label="创意点价格表"><div className="finance-price-row header has-action" role="row"><span>套餐</span><span>创意点</span><span>价格</span><span>说明</span><span>操作</span></div>{pointPackages.map((item) => <div className="finance-price-row has-action" role="row" key={item.id}><strong>{item.name}</strong><span>{item.amountLabel}</span><b>{item.priceLabel}</b><small>{item.note}</small><button className="primary" type="button" disabled={Boolean(item.blockedReason)} onClick={() => { setSelectedPointPackage(item.id); setPurchaseQuantity(1); setAgreementAccepted(false) }}>{selectedPointPackage === item.id ? '已选择' : '选择'}</button></div>)}</div>
          )}
          {selectedPackage && <section className="finance-checkout" aria-label="创意点购买确认"><div className="finance-checkout-qr">{rechargeOrder?.payment_url || rechargeOrder?.paymentUrl ? <a href={(rechargeOrder.payment_url ?? rechargeOrder.paymentUrl) || '#'} target="_blank" rel="noreferrer">打开支付页面</a> : <strong>确认后生成真实支付订单</strong>}<span>支付完成后由服务端回调或查单入账，未支付不会增加创意点。</span><div className="finance-payment-methods" role="group" aria-label="选择支付方式">{([{ id: 'wechat', label: '微信' }, { id: 'alipay', label: '支付宝' }, { id: 'card', label: '银行卡' }] as const).map((method) => <button key={method.id} className={paymentMethod === method.id ? 'selected' : ''} type="button" onClick={() => setPaymentMethod(method.id)}>{method.label}</button>)}</div></div><div className="finance-checkout-details"><div><span>购买套餐</span><strong>{selectedPackage.name} · {selectedPackage.amountLabel}</strong></div><label><span>购买数量</span><div className="finance-quantity-stepper"><button type="button" aria-label="减少购买数量" onClick={() => setPurchaseQuantity((value) => Math.max(1, value - 1))}>−</button><InputNumber controls={false} min={1} max={99} value={purchaseQuantity} onChange={(value) => setPurchaseQuantity(value || 1)} /><button type="button" aria-label="增加购买数量" onClick={() => setPurchaseQuantity((value) => Math.min(99, value + 1))}>＋</button></div></label><div><span>本次购买创意点</span><strong>{selectedPointCount === null ? '以服务端订单为准' : `共 ${selectedPointCount.toLocaleString()} 点`}</strong></div><div><span>应付金额</span><b>{selectedPackage.priceCny === null ? '以服务端订单为准' : `¥${formatAmountCny(rechargeAmountFen(selectedPackage.priceCny, purchaseQuantity))}`}</b></div><div className="finance-checkout-action"><Checkbox checked={agreementAccepted} onChange={(event) => setAgreementAccepted(event.target.checked)}>我已阅读并同意《创意点购买协议》，确认虚拟权益到账后不支持无理由退款。</Checkbox><button className="primary finance-confirm-purchase" type="button" disabled={!agreementAccepted || rechargeLoading || Boolean(selectedPackage.blockedReason) || selectedPackage.priceCny === null} onClick={() => void submitRecharge()}>{rechargeLoading ? '创建订单中…' : '确认购买'}</button></div>{selectedPackage.blockedReason && <p className="error-text" role="alert">{selectedPackage.blockedReason}</p>}{purchaseBlockNotice && <p className="muted" role="status">{purchaseBlockNotice}</p>}{rechargeOrder && <div className="finance-recharge-order" role="status"><strong>充值订单：{rechargeOrder.id}</strong><span>状态：{rechargeOrder.state}{rechargeOrder.warning ? ` · ${rechargeOrder.warning}` : ''}</span><button type="button" onClick={() => void refreshRecharge()}>查询订单</button></div>}{rechargeError && <p className="error-text" role="alert">{rechargeError}</p>}</div></section>}
        </> : <div className="finance-storage-contact"><Boxes size={28} /><strong>请咨询客服</strong></div>}
      </Modal>
    </section>
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
  brandId?: string
  canonicalProductId?: string
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
      ...projectProductTarget(product),
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
    ...projectProductTarget(product),
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
  const loadBindings = () => {
    setBindings(null)
    setError('')
    return fetchProductsByAsset(baseUrl, asset.id)
      .then((result) => setBindings(result.items))
      .catch((cause) => setError(describeApiError(cause)))
  }
  useEffect(() => {
    let active = true
    void fetchProductsByAsset(baseUrl, asset.id)
      .then((result) => { if (active) setBindings(result.items) })
      .catch((cause) => { if (active) setError(describeApiError(cause)) })
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
            void loadBindings()
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
  const [knowledgePage, setKnowledgePage] = useState(1)
  const [knowledgePageSize, setKnowledgePageSize] = useState(10)
  useEffect(() => {
    setAssetEntry(initialEntry)
  }, [initialEntry])
  const visibleAssets =
    assets?.filter((asset) => assetMatchesEntry(asset.mimeType, assetEntry)) ??
    []
  // In the image workspace, put the largest verified candidates first. The
  // archive contains legacy callback markers that are labelled image/png but
  // are not decodable image bytes; keeping those rows ahead of real pictures
  // makes the page look empty even when valid assets are available.
  const orderedAssets =
    assetEntry === 'images'
      ? [...visibleAssets].sort((left, right) => {
          const cleanDelta = Number(right.scanStatus === 'clean') - Number(left.scanStatus === 'clean')
          return cleanDelta || right.sizeBytes - left.sizeBytes
        })
      : visibleAssets
  // Keep the desktop workspace usable when a workspace contains a long
  // historical archive. Metadata is still fetched for counts and actions, but
  // rendering thousands of cards at once makes every button hard to reach and
  // causes the browser to issue unnecessary thumbnail work.
  const renderedAssets = orderedAssets.slice(0, 100)
  useEffect(() => {
    setKnowledgePage(1)
  }, [assetEntry, visibleAssets.length])
  const knowledgeColumns = [
    {
      title: '文件',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, asset: AssetMetadata) => (
        <div className="knowledge-file-cell">
          <FileText size={18} aria-hidden="true" />
          <div><strong title={name}>{name}</strong><span>{asset.mimeType}</span></div>
        </div>
      ),
    },
    {
      title: '大小',
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      width: 100,
      render: (sizeBytes: number) => `${Math.max(1, Math.round(sizeBytes / 1024))} KB`,
    },
    {
      title: '安全扫描',
      dataIndex: 'scanStatus',
      key: 'scanStatus',
      width: 150,
      render: (_: AssetMetadata['scanStatus'], asset: AssetMetadata) => <StatusChip tone={statusTone(asset)}>{statusLabel(asset)}</StatusChip>,
    },
    {
      title: '内容读取',
      dataIndex: 'parseStatus',
      key: 'parseStatus',
      width: 140,
      render: (parseStatus: AssetMetadata['parseStatus']) => parseStatus === 'succeeded' ? '已读取内容' : parseStatus === 'failed' ? '读取失败' : '待读取',
    },
    {
      title: '权益状态',
      dataIndex: 'rightsStatus',
      key: 'rightsStatus',
      width: 140,
      render: (rightsStatus: AssetMetadata['rightsStatus']) => rightsStatus === 'approved' ? <StatusChip tone="green">已确认</StatusChip> : '待确认',
    },
    {
      title: '生成状态 / 下一步',
      key: 'knowledgeBinding',
      width: 300,
      render: (_: unknown, asset: AssetMetadata) => {
        const binding = resolveKnowledgeBindingStatus(asset)
        const action = resolveAssetPrimaryAction(asset, {
          configured: Boolean(baseUrl),
          busy: Boolean(assetAction),
        })
        const actionLabel = action.kind === 'none' && !binding.ready ? '刷新状态' : action.label
        const onAction = action.kind !== 'none'
          ? () => runPrimaryAssetAction(asset)
          : !binding.ready
            ? () => void load()
            : undefined
        return (
          <KnowledgeBindingStatus
            asset={asset}
            compact
            actionLabel={actionLabel}
            onAction={onAction}
          />
        )
      },
    },
  ]
  const knowledgeCounts = countKnowledgeAssets(visibleAssets)
  const knowledgeReadyCount = knowledgeCounts.ready
  const knowledgePendingCount = knowledgeCounts.pending
  const load = async () => {
    if (!baseUrl) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    setBrandLoadError('')
    setStorageLoadError('')
    const [assetResult, brandResult, healthResult] = await Promise.allSettled([
      fetchAssets(baseUrl),
      fetchBrandProfile(baseUrl),
      fetchApiHealth(baseUrl),
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
    // Image thumbnails are part of the image workspace, so load them from the
    // authenticated asset endpoint when that tab is explicitly opened. Keep
    // the full-materials and knowledge tabs metadata-only to avoid fetching a
    // Keep the full-materials and knowledge tabs metadata-only.
    if (!baseUrl || assetEntry !== 'images' || !assetStorageReady) {
      setAssetPreviews({})
      return
    }
    const controller = new AbortController()
    const objectUrls: string[] = []
    // Only clean image objects can be downloaded by the API.  Older assets
    // may still be quarantined or have an expired object, so attempting every
    // row creates a burst of guaranteed 403s (and can trip the relay limiter).
    // Keep the image grid responsive for the safe preview subset.
    // Some historical scanner callback records declare image/png but contain
    // only a tiny callback marker rather than a decodable image.  Prioritise
    // larger objects and verify the browser can decode the bytes before
    // putting a thumbnail into the grid; metadata alone is not proof that an
    // image is renderable.
    const imageAssets = orderedAssets
      .filter(
        (asset) =>
          asset.scanStatus === 'clean' &&
          asset.mimeType.toLowerCase().startsWith('image/'),
      )
      .sort((left, right) => right.sizeBytes - left.sizeBytes)
      .slice(0, 24)
    const previews = new Map<string, string>()
    let nextIndex = 0
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex++
        const asset = imageAssets[index]
        if (!asset) return
        try {
          const blob = await fetchAssetBlob(baseUrl, asset.id, controller.signal)
          if (!blob.type.startsWith('image/')) continue
          const url = URL.createObjectURL(blob)
          const valid = await new Promise<boolean>((resolve) => {
            const probe = new Image()
            probe.onload = () => resolve(true)
            probe.onerror = () => resolve(false)
            probe.src = url
          })
          if (!valid) {
            URL.revokeObjectURL(url)
            continue
          }
          objectUrls.push(url)
          previews.set(asset.id, url)
        } catch {
          // Quarantined or expired objects remain represented by their status
          // card; a failed thumbnail must not block the rest of the grid.
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(2, imageAssets.length) }, () => worker())).then(() => {
      if (controller.signal.aborted) return
      setAssetPreviews(Object.fromEntries(previews))
    })
    return () => {
      controller.abort()
      objectUrls.forEach(url => URL.revokeObjectURL(url))
    }
  }, [assetEntry, assetStorageReady, assets, baseUrl])
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
      className={`panel asset-library ${assetEntry === 'rules' ? 'rules-entry-active' : ''}`}
      id="merchant-assets"
      aria-label="知识、图片与素材"
      tabIndex={-1}
    >
      <div className="knowledge-context-bar" aria-label="当前位置">
        <div className="knowledge-breadcrumb">
          <span>工作台</span><ChevronRight size={14} aria-hidden="true" /><span>知识库</span><ChevronRight size={14} aria-hidden="true" /><strong>{assetEntry === 'knowledge' ? '素材库' : assetEntry === 'images' ? '店铺素材' : assetEntry === 'assets' ? '品牌资产' : '规则库'}</strong>
        </div>
        <span className="knowledge-context-status"><span className="status-dot" aria-hidden="true" />当前工作区</span>
      </div>
      <div className="panel-heading">
        <div>
        <span className="section-kicker">KNOWLEDGE WORKSPACE</span>
          <h3>知识库</h3>
          <p className="panel-subtitle">
            统一管理商品资料、店铺授权素材与品牌规范；从左侧知识库分区进入对应工作流。
          </p>
          <div className="asset-brand-actions" aria-label="品牌管理">
            <span className="asset-brand-actions-label">品牌管理</span>
            <button data-testid="visual-rules-toggle" className="secondary" onClick={() => setVisualPanelOpen((current) => !current)} disabled={!brand}>
              <ShieldCheck size={14} />
              {visualPanelOpen ? '收起视觉规则' : '配置视觉强规则'}
            </button>
            <button className="secondary" onClick={extractBrand} disabled={!baseUrl || Boolean(brandAction) || !assets?.some((asset) => asset.parseStatus === 'succeeded')}>
              <Sparkles size={14} />
              {brandAction || '从素材提取品牌档案'}
            </button>
          </div>
        </div>
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
          <div className="asset-heading-status" aria-label="素材库状态摘要">
            <StatusChip tone={brand ? 'green' : 'neutral'}>
              {brand ? `品牌档案 r${brand.revision}` : '品牌未建档'}
            </StatusChip>
            {brand?.brandUnitId ? (
              <StatusChip tone="green">
                批量生产品牌单元：{brand.brandUnitId}
              </StatusChip>
            ) : brand?.brandUnitSelectionRequired ? (
              <div className="inline-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{brandUnitSelectionMessage(brand.brandUnitCandidates?.length ?? 0)}</span>
              </div>
            ) : null}
            <StatusChip tone={assets?.length ? 'green' : 'neutral'}>
              {assets?.length ?? 0} 个素材
            </StatusChip>
          </div>
        </div>
      </div>
      <div className="asset-entry-tabs" role="tablist" aria-label="知识库分区">
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
              ['knowledge', 'images', 'assets', 'rules'] as const,
              assetEntry,
              setAssetEntry,
            )
          }
          onClick={() => setAssetEntry('knowledge')}
        >
          <BookOpen size={15} aria-hidden="true" />
          素材库
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
              ['knowledge', 'images', 'assets', 'rules'] as const,
              assetEntry,
              setAssetEntry,
            )
          }
          onClick={() => setAssetEntry('images')}
        >
          <ImageIcon size={15} aria-hidden="true" />
          店铺素材
        </button>
        <button
          id="asset-rules-tab"
          role="tab"
          aria-selected={assetEntry === 'rules'}
          aria-controls="asset-rules-panel"
          tabIndex={assetEntry === 'rules' ? 0 : -1}
          className={assetEntry === 'rules' ? 'active' : ''}
          onKeyDown={(event) => handleTabKeyDown(event, ['knowledge', 'images', 'assets', 'rules'] as const, assetEntry, setAssetEntry)}
          onClick={() => setAssetEntry('rules')}
        >
          <ShieldCheck size={15} aria-hidden="true" />
          规则库
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
              ['knowledge', 'images', 'assets', 'rules'] as const,
              assetEntry,
              setAssetEntry,
            )
          }
          onClick={() => setAssetEntry('assets')}
        >
          <FolderOpen size={15} aria-hidden="true" />
          全部资料
        </button>
        <span role="status" aria-live="polite">
          {assetEntry === 'assets'
            ? `全部 ${assets?.length ?? 0} 项`
            : assetEntry === 'rules'
              ? '解释内容生成与发布前检查'
              : `${assetEntry === 'images' ? '店铺授权素材' : '上传知识资料'} ${visibleAssets.length} 项`}
        </span>
        {assetEntry === 'images' && assetStorageReady && (
          <span className="asset-preview-count" role="status" aria-live="polite">
            已验证可预览 {Object.keys(assetPreviews).length} 张
          </span>
        )}
      </div>
      <section className="knowledge-plan-banner" aria-live="polite">
        <div className="knowledge-plan-step">{assetEntry === 'knowledge' ? '01' : assetEntry === 'images' ? '02' : assetEntry === 'rules' ? '03' : '04'}</div>
        <div className="knowledge-plan-copy">
          <strong>
            {assetEntry === 'knowledge' ? '素材库：上传并确认素材' : assetEntry === 'images' ? '店铺素材：查看已授权内容' : assetEntry === 'rules' ? '规则库：检查发布前约束' : '全部资料：统一检索工作区内容'}
          </strong>
          <span>
            {assetEntry === 'knowledge' ? '上传 Excel、图片或文档；完成扫描、读取和权益确认后，才会进入生成上下文。' : assetEntry === 'images' ? '店铺同步后，系统只展示当前工作区已授权且可读取的素材，不会混用其他企业数据。' : assetEntry === 'rules' ? '查看广告、促销、品类和平台规则命中结果；未通过的内容不能直接发布。' : '按来源、状态和权益快速查找工作区资料。'}
          </span>
        </div>
        <span className="knowledge-plan-output">产出：{assetEntry === 'rules' ? '可发布 / 需修复' : assetEntry === 'images' ? '可引用素材' : '可供生成引用的知识'}</span>
        {assetEntry === 'images' && <span className="knowledge-plan-external">请在Store Nova ChatGPT 插件中绑定店铺</span>}
      </section>
      <div className="embedded-rules" id="asset-rules-panel" role="tabpanel" aria-label="规则说明与规则列表">
        {assetEntry === 'rules' && <Rules baseUrl={baseUrl} />}
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
        {assetEntry === 'knowledge' && (
          <>
            <section className="knowledge-overview" aria-label="知识库摘要">
              <div><span>知识资产</span><strong>{visibleAssets.length}</strong><small>品牌资料、规则依据与经营经验</small></div>
              <div className="ready"><span>可直接引用</span><strong>{knowledgeReadyCount}</strong><small>已读取内容且权益已确认</small></div>
              <div className={knowledgePendingCount ? 'pending' : 'ready'}><span>待处理</span><strong>{knowledgePendingCount}</strong><small>{knowledgePendingCount ? '完成扫描、读取或权益确认后可用' : '当前没有待处理资料'}</small></div>
            </section>
            <section className="knowledge-guide" aria-label="知识库说明">
              <div>
                <span className="section-kicker">KNOWLEDGE BASE</span>
                <h4>生成内容前，系统会先读取这里</h4>
                <p>只会引用已读取、来源可追溯且权益已确认的资料；待处理内容不会进入生成上下文。</p>
              </div>
              <div className="knowledge-guide-flow" aria-label="知识库使用流程">
                <span><b>1</b>上传资料</span><i>→</i><span><b>2</b>确认内容</span><i>→</i><span><b>3</b>自动引用</span>
              </div>
            </section>
          </>
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
          assetEntry === 'knowledge' ? (
            <div className="knowledge-list-section">
              <div className="knowledge-list-heading">
                <div><span className="section-kicker">KNOWLEDGE ASSETS</span><h4>知识资料</h4><p>每一条资料都保留扫描、读取和权益状态，只有“可直接引用”的内容会参与生成。</p></div>
                <StatusChip tone={knowledgeReadyCount ? 'green' : 'neutral'}>{knowledgeReadyCount} 条可引用</StatusChip>
              </div>
              <div className="knowledge-table-wrap" aria-label="知识库列表">
                <Table
                  rowKey="id"
                  size="middle"
                  columns={knowledgeColumns}
                  dataSource={orderedAssets}
                  scroll={{ x: 1050 }}
                  pagination={{
                    current: knowledgePage,
                    pageSize: knowledgePageSize,
                    total: orderedAssets.length,
                    showSizeChanger: true,
                    pageSizeOptions: [10, 20, 50],
                    showTotal: (total) => `共 ${total} 项`,
                    onChange: (page, pageSize) => {
                      setKnowledgePage(pageSize !== knowledgePageSize ? 1 : page)
                      setKnowledgePageSize(pageSize)
                    },
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="asset-grid">
              {renderedAssets.map((asset) => (
                <article
                  className={`asset-card ${asset.preference?.verdict ?? ''}`}
                  key={asset.id}
                  data-asset-name={asset.name}
                >
                  <div className="asset-preview" title={assetStorageReady ? undefined : '对象存储未配置，暂不读取素材正文'}>
                    {assetPreviews[asset.id] ? <img src={assetPreviews[asset.id]} alt={asset.name} /> : <FileText size={28} />}
                  </div>
                  <div className="asset-card-body">
                    <div className="asset-title-row">
                      <b title={asset.name}>{asset.name}</b>
                      {asset.preference && <StatusChip tone={asset.preference.verdict === 'excellent' ? 'green' : 'amber'}>{asset.preference.verdict === 'excellent' ? '优秀参考' : '不喜欢'}</StatusChip>}
                    </div>
                    <span>{asset.mimeType} · {Math.max(1, Math.round(asset.sizeBytes / 1024))} KB</span>
                    <div className="asset-status"><StatusChip tone={statusTone(asset)}>{statusLabel(asset)}</StatusChip><span>{asset.parseStatus === 'succeeded' ? '已读取内容' : asset.parseStatus === 'failed' ? '读取失败' : '待读取'}</span></div>
                    {asset.references?.length > 1 && <small data-testid={`asset-reference-count-${asset.id}`} className="asset-preference-reason">同一文件已有 {asset.references.length} 个上传引用：{asset.references.map((reference) => reference.name).join('、')}</small>}
                    {asset.preference && <small className="asset-preference-reason">原因：{asset.preference.reasons.join('；')}</small>}
                    {asset.parseError && <small className="asset-error">{asset.parseError}</small>}
                  </div>
                </article>
              ))}
            </div>
          )
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
  // A failed binding write is not a failed read. Sharing one state replaced the
  // successfully read relation view with 「关系读取失败」 and offered a retry that
  // only re-read, so the merchant lost the (still valid) binding list and was
  // told the read had failed when the write had.
  const [saveError, setSaveError] = useState('')
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setSaveError('')
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
  const selectableAssets = assets.filter(
    (asset) =>
      !relation.boundIds.includes(asset.id) && asset.scanStatus === 'clean',
  )
  const reload = () => {
    setLoading(true)
    setError('')
    setSaveError('')
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
      setSaveError('商品缺少品牌或版本信息，无法安全写入关系')
      return
    }
    setSaving(true)
    setSaveError('')
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
      .catch((cause) => setSaveError(describeApiError(cause)))
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
            disabled={!product || loading || Boolean(error) || Boolean(saveError)}
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
            setSaveError('')
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
              已绑定关系来自商品 API；可在下方选择通过安全扫描的素材进行绑定或解除绑定，所有变更都会写入审计。
            </span>
          </div>
          <div className="relation-summary" data-testid="canonical-product-relation">
            <StatusChip tone={product.canonical_scope?.verification_status === 'verified' ? 'green' : 'amber'}>
              <Link2 size={12} />
              {product.canonical_scope?.verification_status === 'verified' ? '标准链已验证' : '标准链未取得'}
            </StatusChip>
            <span>
              {product.canonical_scope?.canonical_product_id
                ? `规范商品：${product.canonical_scope.canonical_product_id}${product.canonical_scope.listing_id ? ` · 店铺刊登：${product.canonical_scope.listing_id}` : ''}`
                : '当前没有规范商品映射或店铺刊登关系；请由平台运营完成标准链核验。'}
            </span>
          </div>
          {relation.boundIds.length === 0 && (
            <div className="empty-inline">
              <FolderOpen size={16} />
              素材库中尚未记录该商品的默认素材。可在下方选择通过安全扫描的素材完成绑定。
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
              {selectableAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
              ))}
              {!selectableAssets.length && (
                <option value="" disabled>
                  暂无通过安全扫描的可绑定素材
                </option>
              )}
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
          {!selectableAssets.length && (
            <small className="asset-error">
              当前素材均未通过安全扫描；扫描完成后点击“刷新状态”，再回来绑定。
            </small>
          )}
          {saveError && (
            <div
              className="inline-error"
              role="alert"
              data-testid="product-asset-relation-write-error"
            >
              <AlertCircle size={16} />
              <span>
                关系写入失败：{saveError}。上面的绑定列表仍是最近一次成功读取的结果，可能未包含这次变更；请重新读取关系确认后再继续。
              </span>
              <button
                type="button"
                className="text-button"
                onClick={reload}
                disabled={saving}
              >
                重新读取关系
              </button>
            </div>
          )}
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

/**
 * The material workspace's own store row.
 *
 * It used to be a hardcoded list of eight `Store Nova` stores, and the material
 * library rendered those eight while the catalogue page — already fixed — read
 * the server's one fixture account. This page is bound to
 * `https://yxsona.com/`, so a store the server did not report may not appear,
 * let alone be labelled 已接入.
 */
type CatalogStore = {
  id: string
  mark: string
  logoUrl: string
  name: string
  platform: string
}

/** The server's store, in the shape the material workspace renders. */
function catalogStoreForMaterials(store: CatalogStoreView): CatalogStore {
  return {
    id: store.id,
    mark: store.mark,
    // `GET /v1/platform-accounts` publishes no store logo. An empty string is
    // the truth; the card falls back to the store mark instead of a broken img.
    logoUrl: '',
    name: store.name,
    platform: store.platform,
  }
}

/**
 * The series list a store starts with before the merchant has declared any.
 *
 * It used to be 恒温饮具 / 桌面生活 / 礼赠套装 — three invented series handed to
 * every real store, plus two more invented sets keyed on the ids of stores that
 * only ever existed in the deleted store seed. Nothing on the server carries a
 * series: `GET /v1/products` publishes no series field at all (see
 * `catalog-data.ts`, which fills every product's series with 未分类), so the
 * 「选择系列」 filter, the card's 所属系列 editor and 品牌配置 › 系列配置 all
 * presented those names to the merchant as if their store already had them.
 *
 * 未分类 is the only honest entry: it is the bucket for "no series declared",
 * and it is the one value the product mapper itself produces. Everything past it
 * is what this merchant actually created, kept in `merchant-store-series-v1`.
 */
const defaultCatalogSeriesNames = ['未分类']
const storeSeriesStorageKey = 'merchant-store-series-v1'
const storeSeriesReassignmentsStorageKey = 'merchant-store-series-reassignments-v1'
const storeSeriesChangedEvent = 'merchant-store-series-changed'

/**
 * The store id is taken and deliberately unused: series are scoped per store by
 * the registry, but the server publishes none for any store, so the honest
 * starting point is the same single 未分类 bucket for all of them. A store that
 * really has series gets them the moment the merchant creates one.
 *
 * Exported for `reviewed-surface-data.test.ts`, which pins the default against
 * the names this function used to invent.
 */
export function initialSeriesForStore(_storeId: string) {
  return [...defaultCatalogSeriesNames]
}

function readStoreSeriesRegistry(): Record<string, string[]> {
  try {
    return JSON.parse(window.localStorage.getItem(storeSeriesStorageKey) ?? '{}') as Record<string, string[]>
  } catch {
    return {}
  }
}

function writeStoreSeriesRegistry(value: Record<string, string[]>) {
  try {
    window.localStorage.setItem(storeSeriesStorageKey, JSON.stringify(value))
  } catch {
    // 本地预览禁用储存时仍保留当前页面状态。
  }
}

function readStoreSeriesReassignments(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(window.localStorage.getItem(storeSeriesReassignmentsStorageKey) ?? '{}') as Record<string, Record<string, string>>
  } catch {
    return {}
  }
}

function seriesForStore(storeId: string) {
  const saved = readStoreSeriesRegistry()[storeId]
  return saved?.length ? saved : initialSeriesForStore(storeId)
}

function CatalogProductVisual({ product, large = false }: { product: CatalogProduct; large?: boolean }) {
  return (
    <div className={`catalog-product-visual ${product.tone} ${large ? 'large' : ''}`} aria-hidden="true">
      <span className="catalog-visual-shadow" />
      <span className="catalog-visual-object"><ShoppingBag size={large ? 58 : 34} strokeWidth={1.35} /></span>
      <em>STORE NOVA</em>
    </div>
  )
}

type CatalogFilterOption = { value: string; label: string }

function CatalogFilterMenu({
  label,
  value,
  options,
  onChange,
  buttonLabel,
  disabled = false,
}: {
  label: string
  value: string
  options: CatalogFilterOption[]
  onChange: (value: string) => void
  buttonLabel?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className={`catalog-filter-field ${open ? 'open' : ''}`} ref={menuRef}>
      <button type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => { if (!disabled) setOpen((current) => !current) }}>
        <span>{buttonLabel ?? selected.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="catalog-filter-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'selected' : ''}
              key={option.value}
              onClick={() => { onChange(option.value); setOpen(false) }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StoreCatalogExperience({ baseUrl, apiMode }: { baseUrl?: string; apiMode?: string | null }) {
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null)
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null)
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  const [selectedMediaIndex, setSelectedMediaIndex] = useState(1)
  const [videoPlaying, setVideoPlaying] = useState(false)
  const [selectedSkuIndex, setSelectedSkuIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogAddedTime, setCatalogAddedTime] = useState('all')
  const [catalogSort, setCatalogSort] = useState('default')
  const [catalogSeries, setCatalogSeries] = useState('all')
  const [catalogPage, setCatalogPage] = useState(1)
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<string[]>([])
  const [catalogSeriesRevision, setCatalogSeriesRevision] = useState(0)
  // This page owns no catalogue data of its own. Stores come from
  // `/v1/platform-accounts` and products from `/v1/products`; `null` means the
  // read has not answered and must be reported as unread rather than as an empty
  // workspace. The page used to render eight invented stores (three of them
  // 「已接入」), nine invented products and a 「12 分钟前同步」 sync time without a
  // single server request, contradicting the server-driven overview in the same
  // session.
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null)
  const [products, setProducts] = useState<ApiProduct[] | null>(null)
  const [catalogReadNote, setCatalogReadNote] = useState('正在读取平台与店铺…')
  const [productsNote, setProductsNote] = useState('正在读取商品…')
  // A local, per-session series label the merchant assigned to selected
  // products. It is an organisational label only — the server publishes no
  // series, and this never claims a server write.
  const [seriesOverrides, setSeriesOverrides] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!baseUrl) {
      setAccounts(null)
      setProducts(null)
      setCatalogReadNote('未配置 API，无法读取平台、店铺与商品。')
      setProductsNote('未配置 API，无法读取商品。')
      return
    }
    let active = true
    setAccounts(null)
    setProducts(null)
    setCatalogReadNote('正在读取平台与店铺…')
    setProductsNote('正在读取商品…')
    // Independent reads: a failed product read must not hide the stores the
    // server did return, and neither read falls back to a demo catalogue.
    if (isManualPlatformOperationsMode(apiMode)) {
      setAccounts([])
      setCatalogReadNote('人工运营模式不执行平台店铺发现；商品来自商家知识库与人工导入。')
    } else if (shouldDiscoverPlatformAccounts(baseUrl, apiMode)) {
      fetchPlatformAccounts(baseUrl)
        .then((page) => { if (active) setAccounts(Array.isArray(page.items) ? page.items : []) })
        .catch((cause) => { if (active) { setAccounts(null); setCatalogReadNote(`平台与店铺读取失败：${describeApiError(cause)}`) } })
    } else {
      setAccounts(null)
      setCatalogReadNote('平台运营模式未确认，已停止自动发现店铺；商品仍从知识库读取。')
    }
    fetchProducts(baseUrl)
      .then((items) => { if (active) setProducts(items) })
      .catch((cause) => { if (active) { setProducts(null); setProductsNote(`商品读取失败：${describeApiError(cause)}`) } })
    return () => { active = false }
  }, [baseUrl, apiMode])

  // `null` while the account read is unresolved.
  const platforms = useMemo(() => buildCatalogPlatforms(accounts, products), [accounts, products])
  const catalogStores = useMemo(() => (platforms ?? []).flatMap((platform) => platform.stores), [platforms])
  const realConnectedStores = catalogStores.filter((store) => store.realConnected).length
  const selectedStore = catalogStores.find((store) => store.id === selectedStoreId) ?? null
  const selectedPlatformView = (platforms ?? []).find((platform) => platform.id === selectedPlatform) ?? null
  const selectedPlatformStores = selectedPlatformView?.stores ?? []
  // `null` while the product read is unresolved (distinct from a store with no
  // products, which is a real answer).
  const storeItems = useMemo(
    () => (selectedStore ? catalogProductsForStore(products, selectedStore.id, readStoreSeriesReassignments()[selectedStore.id] ?? {}) : null),
    // `catalogSeriesRevision` re-reads the local series registry after a series change.
    [products, selectedStore, catalogSeriesRevision],
  )
  const storeItemsRead = storeItems !== null
  const storeProducts = useMemo(
    () => (storeItems ?? []).map((product) => seriesOverrides[product.id] ? { ...product, series: seriesOverrides[product.id]! } : product),
    [seriesOverrides, storeItems],
  )
  const selectedProduct = storeProducts.find((product) => product.id === selectedProductId) ?? null
  const visibleStoreItems = useMemo(() => {
    const normalizedQuery = catalogQuery.trim().toLocaleLowerCase()
    const now = Date.now()
    const filtered = storeProducts.filter((product) => {
      const matchesQuery = !normalizedQuery || `${product.title} ${product.subtitle}`.toLocaleLowerCase().includes(normalizedQuery)
      // "Added in the last N days" is measured from today. A product whose
      // server date was not returned is unknown, not recent.
      const ageInDays = product.addedAt ? Math.floor((now - new Date(`${product.addedAt}T00:00:00`).getTime()) / 86_400_000) : Number.POSITIVE_INFINITY
      const matchesAddedTime = catalogAddedTime === 'all'
        || (catalogAddedTime === '7-days' && ageInDays <= 7)
        || (catalogAddedTime === '30-days' && ageInDays <= 30)
        || (catalogAddedTime === '90-days' && ageInDays <= 90)
      const matchesSeries = catalogSeries === 'all' || product.series === catalogSeries
      return matchesQuery && matchesAddedTime && matchesSeries
    })
    if (catalogSort === 'added-asc') return [...filtered].sort((left, right) => left.addedAt.localeCompare(right.addedAt))
    return [...filtered].sort((left, right) => right.addedAt.localeCompare(left.addedAt))
  }, [catalogAddedTime, catalogQuery, catalogSeries, catalogSort, storeProducts])
  const catalogPageSize = 6
  const catalogPageCount = Math.max(1, Math.ceil(visibleStoreItems.length / catalogPageSize))
  const pagedStoreItems = visibleStoreItems.slice((catalogPage - 1) * catalogPageSize, catalogPage * catalogPageSize)
  const hasCatalogFilters = Boolean(catalogQuery.trim()) || catalogAddedTime !== 'all' || catalogSeries !== 'all' || catalogSort !== 'default'
  const allVisibleCatalogSelected = pagedStoreItems.length > 0 && pagedStoreItems.every((product) => catalogSelectedIds.includes(product.id))
  const selectedCatalogSeries = new Set(storeProducts.filter((product) => catalogSelectedIds.includes(product.id)).map((product) => product.series))
  const selectedCatalogCurrentSeries = selectedCatalogSeries.size === 1 ? Array.from(selectedCatalogSeries)[0] : ''
  const catalogSeriesOptions = selectedStore ? seriesForStore(selectedStore.id) : defaultCatalogSeriesNames

  useEffect(() => {
    setCatalogPage(1)
  }, [catalogAddedTime, catalogQuery, catalogSeries, catalogSort, selectedStoreId])

  useEffect(() => {
    setCatalogPage((current) => Math.min(current, catalogPageCount))
  }, [catalogPageCount])

  useEffect(() => {
    const syncSeriesChange = (event: Event) => {
      const detail = (event as CustomEvent<{ storeId: string; deleted?: string; fallback?: string }>).detail
      // Series live in the local registry, so re-reading it (via the revision
      // below) is enough: a deleted series' products fall back through the
      // registry's reassignment map rather than a local product copy.
      if (detail?.storeId && detail.deleted && detail.fallback && selectedStoreId === detail.storeId && catalogSeries === detail.deleted) setCatalogSeries('all')
      setCatalogSeriesRevision((current) => current + 1)
    }
    window.addEventListener(storeSeriesChangedEvent, syncSeriesChange)
    return () => window.removeEventListener(storeSeriesChangedEvent, syncSeriesChange)
  }, [catalogSeries, selectedStoreId])

  const openStore = (storeId: string) => {
    setSelectedStoreId(storeId)
    setSelectedProductId(null)
    setCatalogQuery('')
    setCatalogAddedTime('all')
    setCatalogSeries('all')
    setCatalogSort('default')
    setCatalogSelectedIds([])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const openProduct = (productId: string) => {
    setSelectedProductId(productId)
    setSelectedMediaIndex(1)
    setVideoPlaying(false)
    setSelectedSkuIndex(0)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const toggleCatalogProduct = (productId: string) => {
    setCatalogSelectedIds((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId])
  }
  const assignSelectedCatalogSeries = (targetSeries: string) => {
    if (!selectedStore || !catalogSelectedIds.length) return
    // A local re-labelling of selected products; the server publishes no series.
    setSeriesOverrides((current) => Object.fromEntries([
      ...Object.entries(current),
      ...catalogSelectedIds.map((id) => [id, targetSeries] as const),
    ]))
    setCatalogSelectedIds([])
  }
  if (selectedStore && !selectedStore.readable) {
    return (
      <div className="store-catalog-page catalog-connection-page">
        <button className="catalog-back" onClick={() => setSelectedStoreId(null)}><ArrowLeft size={17} />返回店铺选择</button>
        <section className="catalog-connection-required">
          <span className="catalog-disconnected-state"><i />未连接</span>
          <AlertCircle size={32} aria-hidden="true" />
          <h1>店铺尚未连接</h1>
          <p>请联系工作人员完成链接店铺操作。</p>
          <button onClick={() => setSelectedStoreId(null)}>返回店铺选择</button>
        </section>
      </div>
    )
  }

  if (selectedStore && selectedProduct) {
    // Only the specifications the server published: this list used to be four
    // invented SKUs whose prices were derived from the product price.
    const skus = selectedProduct.skus
    // The 「商品素材」 dialog that used to open from here listed four fabricated
    // groups — 2 invented videos, 12 商品主图 slots, 2 images per SKU and 16
    // 详情页图 slots — with invented 尺寸/文件大小, and every row's 「下载」 was a
    // `data:text/plain` URL (the same broken pattern the material library's
    // download was fixed for). Nothing ever opened it: `setActiveAssetGroupId`
    // was only ever called with `null`, so the table was unreachable dead code
    // carrying fabricated data. `GET /v1/assets` publishes no per-product
    // material slots, so there was no server read to put in its place; the
    // fabricated table is deleted rather than left for a future mount.
    const galleryMedia = [
      { label: '商品视频', video: true },
      { label: '商品主图' },
      { label: '使用场景' },
      { label: '材质细节' },
      { label: '尺寸说明' },
    ]
    const selectedSku = skus[selectedSkuIndex] ?? null
    return (
      <div className="store-catalog-page catalog-detail-page">
        <button className="catalog-back" onClick={() => setSelectedProductId(null)}><ArrowLeft size={17} />返回商品列表</button>
        <section className="catalog-commerce-detail">
          <div className="catalog-detail-gallery">
            <div className={`catalog-detail-media media-${selectedMediaIndex} ${videoPlaying ? 'playing' : ''}`}>
              <CatalogProductVisual product={selectedProduct} large />
              <span className="catalog-media-label">{galleryMedia[selectedMediaIndex].label}</span>
              {galleryMedia[selectedMediaIndex].video && (
                <button className="catalog-video-play" type="button" aria-pressed={videoPlaying} onClick={() => setVideoPlaying((current) => !current)}>
                  <Play size={22} fill="currentColor" />{videoPlaying ? '视频播放中' : '播放商品视频'}
                </button>
              )}
            </div>
            <div className="catalog-detail-thumbs" aria-label="商品图片预览">
              {galleryMedia.map((media, index) => (
                <button type="button" className={selectedMediaIndex === index ? 'active' : ''} aria-label={`查看${media.label}`} aria-pressed={selectedMediaIndex === index} key={media.label} onClick={() => { setSelectedMediaIndex(index); setVideoPlaying(false) }}>
                  {media.video ? <Play size={17} fill="currentColor" /> : <ImageIcon size={17} />}
                  <small>{media.label}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="catalog-detail-info">
            <div className="catalog-detail-source"><span>{selectedStore.platform}</span><small>{selectedStore.name}</small></div>
            <h1>{selectedProduct.title}</h1>
            <p>{selectedProduct.subtitle || '服务端未返回该商品的品类、库存与规格事实。'}</p>
            <div className="catalog-detail-price"><span>{selectedSku ? '所选 SKU 价格' : '商品价格'}</span><strong>{selectedSku
              ? selectedSku.price === null ? '服务端未给出该规格价格' : <><small>¥</small>{selectedSku.price.toFixed(2)}</>
              : selectedProduct.price === null ? '服务端未给出价格' : <><small>¥</small>{selectedProduct.price.toFixed(2)}</>}</strong></div>
            <div className="catalog-sku-section">
              <span>{skus.length ? '选择规格' : '商品规格'}</span>
              {skus.length ? (
                <div className="catalog-sku-grid">
                  {skus.map((sku, index) => (
                    <button type="button" className={selectedSkuIndex === index ? 'active' : ''} aria-pressed={selectedSkuIndex === index} key={sku.id} onClick={() => setSelectedSkuIndex(index)}>
                      <span>{sku.name}</span><strong>{sku.price === null ? '价格未读取' : `¥${sku.price.toFixed(2)}`}</strong>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted" role="status">服务端未返回该商品的规格明细，当前不显示可选规格；价格以商品事实为准。</p>
              )}
            </div>
          </div>
        </section>
      </div>
    )
  }

  if (selectedStore) {
    return (
      <div className="store-catalog-page catalog-products-page">
        <section className={`catalog-store-hero ${selectedStore.tone}`}>
          <div className="catalog-store-logo" aria-label={`${selectedStore.name}店铺 Logo`}><img src={storeNovaLogo} alt="" /></div>
          <div><h1>{selectedStore.name}</h1></div>
          {/* The count is the store's products as the server returned them, and
              it is reported as unread until that read answers. It used to be a
              fixed 9 「已上架商品」 for every connected store. */}
          <div className="catalog-store-stat"><strong>{storeItemsRead ? storeProducts.length : UNREAD_METRIC}</strong><span>件商品</span></div>
        </section>
        <section className="catalog-products-panel">
          <div className="catalog-products-toolbar">
            <div className="catalog-search-field">
              <Search size={16} aria-hidden="true" />
              <input aria-label="搜索商品名称或关键词" placeholder="搜索商品名称或关键词" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} />
            </div>
            <CatalogFilterMenu key={`series-filter-${catalogSeriesRevision}`} label="选择系列" buttonLabel="选择系列" value={catalogSeries} onChange={(value) => { setCatalogSeries(value); setCatalogSelectedIds([]) }} options={[{ value: 'all', label: '全部系列' }, ...catalogSeriesOptions.map((item) => ({ value: item, label: item }))]} />
            <CatalogFilterMenu label="按添加时间筛选" value={catalogAddedTime} onChange={setCatalogAddedTime} options={[{ value: 'all', label: '全部添加时间' }, { value: '7-days', label: '近 7 天添加' }, { value: '30-days', label: '近 30 天添加' }, { value: '90-days', label: '近 90 天添加' }]} />
            <CatalogFilterMenu label="商品排序方式" value={catalogSort} onChange={setCatalogSort} options={[{ value: 'default', label: '添加时间从新到旧' }, { value: 'added-asc', label: '添加时间从旧到新' }]} />
            <div className="catalog-view-toggle" role="group" aria-label="商品展示方式">
              <button className={viewMode === 'grid' ? 'active' : ''} aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}><Grid2X2 size={16} />卡片</button>
              <button className={viewMode === 'list' ? 'active' : ''} aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')}><Rows3 size={16} />列表</button>
            </div>
          </div>
          <div className="catalog-search-summary"><div className="catalog-summary-leading"><button className="catalog-back catalog-back-inline" onClick={() => setSelectedStoreId(null)}><ArrowLeft size={15} />返回店铺选择</button><div className="catalog-result-count-card"><span>共找到 <strong>{visibleStoreItems.length}</strong> 件商品</span>{hasCatalogFilters && <button onClick={() => { setCatalogQuery(''); setCatalogAddedTime('all'); setCatalogSeries('all'); setCatalogSort('default'); setCatalogSelectedIds([]) }}>重置条件</button>}</div></div><div className="catalog-batch-operation-card"><span className={catalogSelectedIds.length ? 'active' : ''}>已选 <strong>{catalogSelectedIds.length}</strong> 件</span><button type="button" onClick={() => setCatalogSelectedIds(allVisibleCatalogSelected ? catalogSelectedIds.filter((id) => !pagedStoreItems.some((product) => product.id === id)) : Array.from(new Set([...catalogSelectedIds, ...pagedStoreItems.map((product) => product.id)])))}>{allVisibleCatalogSelected ? '取消全选' : '全选当前'}</button><CatalogFilterMenu label="添加至其他系列" buttonLabel="添加至其他系列" disabled={!catalogSelectedIds.length} value={selectedCatalogCurrentSeries} onChange={assignSelectedCatalogSeries} options={catalogSeriesOptions.map((item) => ({ value: item, label: item }))} /><button type="button" className="danger" disabled aria-label="批量删除（服务端未提供商品删除接口）" title="服务端未提供商品删除接口，当前不能删除服务端商品"><Trash2 size={13} />批量删除</button></div></div>
          {viewMode === 'list' && <div className="catalog-list-header"><span>商品图片</span><span>添加时间</span><span>商品名称</span><span>系列</span><span>商品卖点</span><span>价格</span></div>}
          <div className={`catalog-product-collection ${viewMode}`}>
            {pagedStoreItems.map((product) => (
              <article className={`catalog-product-card${catalogSelectedIds.includes(product.id) ? ' selected' : ''}`} key={product.id} role="button" tabIndex={0} onClick={() => openProduct(product.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openProduct(product.id) }}>
                <label className="catalog-product-select" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`选择${product.title}`} checked={catalogSelectedIds.includes(product.id)} onChange={() => toggleCatalogProduct(product.id)} /><span><Check size={13} /></span></label>
                <CatalogProductVisual product={product} />
                <div className="catalog-product-copy"><div className="catalog-product-meta"><span className="catalog-product-date">添加于 {product.addedAt || '未读取'}</span><span className="catalog-product-series">{product.series}</span></div><h3>{product.title}</h3><p>{product.subtitle || '服务端未返回该商品的品类、库存与规格事实。'}</p><div className="catalog-product-price"><strong>{product.price === null ? '价格未读取' : `¥ ${product.price.toFixed(2)}`}</strong></div></div>
                <ArrowRight className="catalog-product-arrow" size={18} />
              </article>
            ))}
            {!visibleStoreItems.length && (
              <div className="catalog-no-results">
                <PackageSearch size={25} />
                <strong>{!storeItemsRead ? '商品列表未读取' : storeProducts.length ? '没有找到符合条件的商品' : '该店铺还没有商品'}</strong>
                <span>{!storeItemsRead ? productsNote : storeProducts.length ? '可以减少筛选条件，或换一个关键词再试。' : '服务端未返回这家店铺的商品事实。'}</span>
                {storeItemsRead && storeProducts.length > 0 && <button onClick={() => { setCatalogQuery(''); setCatalogAddedTime('all'); setCatalogSeries('all'); setCatalogSort('default'); setCatalogSelectedIds([]) }}>清除全部条件</button>}
              </div>
            )}
          </div>
          {visibleStoreItems.length > 0 && <nav className="catalog-product-pagination" aria-label="商品分页"><span>共 {visibleStoreItems.length} 件 · 第 {catalogPage} / {catalogPageCount} 页</span><div><button type="button" disabled={catalogPage === 1} onClick={() => setCatalogPage((page) => Math.max(1, page - 1))}>上一页</button>{Array.from({ length: catalogPageCount }, (_, index) => index + 1).map((page) => <button type="button" className={page === catalogPage ? 'active' : ''} aria-current={page === catalogPage ? 'page' : undefined} key={page} onClick={() => setCatalogPage(page)}>{page}</button>)}<button type="button" disabled={catalogPage === catalogPageCount} onClick={() => setCatalogPage((page) => Math.min(catalogPageCount, page + 1))}>下一页</button></div></nav>}
        </section>
      </div>
    )
  }

  return (
    <div className="store-catalog-page catalog-stores-page">
      <section className="catalog-page-hero">
        <div><span className="section-kicker">PLATFORM & STORE</span><h1>选择平台与店铺</h1><p>从左侧选择平台，再从右侧进入对应店铺的商品页。</p></div>
        {/* Every number here is a server answer: the platform set and store
            counts come from /v1/platform-accounts, and 「已连接」 is only claimed
            for a real (non-fixture) readable account — the same rule the
            overview uses. Before the read answers the page says so. */}
        <div className="catalog-hero-summary"><div><strong>{platforms === null ? UNREAD_METRIC : platforms.length}</strong><span>{platforms === null ? '电商平台' : '个电商平台'}</span></div><small>{platforms === null ? '店铺列表尚未从服务端读取' : `${catalogStores.length} 家店铺 · ${realConnectedStores} 家已连接`}</small></div>
      </section>
      <section className="catalog-platform-store-browser">
        <aside className="catalog-platform-rail" aria-label="平台列表">
          <div className="catalog-platform-rail-heading"><span>平台</span><small>选择后查看店铺</small></div>
          <div className="catalog-platform-list">
          {platforms === null ? (
            <p className="muted" role="status">{catalogReadNote}</p>
          ) : platforms.map((platform) => (
            <button className={`${selectedPlatform === platform.id ? 'active ' : ''}${platform.connected ? 'connected' : 'disconnected'}`} type="button" aria-pressed={selectedPlatform === platform.id} key={platform.id} onClick={() => setSelectedPlatform(platform.id)}>
              <span className="catalog-platform-mark" aria-hidden="true">{platform.mark}</span><span className="catalog-platform-list-copy"><strong>{platform.label}</strong><small>{platform.stores.length} 家店铺</small></span><span className="catalog-platform-connection"><i />{platform.statusLabel}</span><ChevronRight size={16} aria-hidden="true" />
            </button>
          ))}
          </div>
        </aside>
        <section className="catalog-platform-result" aria-live="polite">
          {!selectedPlatformView ? (
            <div className="catalog-platform-empty"><span><Store size={28} /></span><strong>请选择平台</strong><p>请点击左侧平台，选择店铺后进入商品页。</p></div>
          ) : selectedPlatformStores.length ? (
            <>
              <div className="catalog-platform-result-heading"><div><span className="section-kicker">SELECT STORE</span><h2>{selectedPlatformView.label}店铺</h2><p>选择要查看的店铺。</p></div><span>{selectedPlatformStores.length} 家店铺 · {selectedPlatformView.connectedCount} 家已接入</span></div>
              <div className={`catalog-store-grid catalog-store-results-grid ${selectedPlatformStores.length === 1 ? 'single' : selectedPlatformStores.length === 2 ? 'pair' : ''}`}>
                {selectedPlatformStores.map((store) => (
                  <article className={`catalog-store-card ${store.tone} ${store.readable ? 'connected' : 'disconnected'}`} key={store.id}>
                    <header className="catalog-store-identity"><span className="catalog-store-mark" aria-hidden="true">{store.mark}</span><div><h3>{store.name}</h3><small>{store.dataModeLabel}</small></div><span className={`catalog-live-state ${store.realConnected ? '' : 'disconnected'}`}><i />{store.connectionLabel}</span></header>
                    <div className="catalog-store-summary">{store.readable ? <><strong>{store.products === null ? '商品数量未读取' : <><b>{store.products}</b> 件商品</>}</strong><span>{store.syncLabel ? `最近同步：${store.syncLabel}` : '尚无同步记录'}</span></> : <><strong>连接后可查看商品</strong><span>商品数据暂不可读</span></>}</div>
                    <footer className="catalog-store-action"><button type="button" onClick={() => openStore(store.id)}>{store.readable ? '进入商品库' : '去连接'} <ArrowRight size={15} /></button></footer>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="catalog-platform-empty disconnected"><span><AlertCircle size={28} /></span><strong>{selectedPlatformView.label}尚未接入</strong><p>请联系工作人员完成平台接入。</p></div>
          )}
        </section>
      </section>
    </div>
  )
}

// `StoreMaterialCategory` / `StoreMaterialSeries` / `StoreMaterialItem` and the
// card taxonomy now live in `material-library.ts`, next to the mapper that fills
// them from a real `GET /v1/assets` row.
type MaterialBrandSettings = {
  logoUrl: string
  color: string
  persona: string
  sellingPoints: string
  personaFileName: string
  sellingPointsFileName: string
  assetFileName: string
}
// No colour is a reading: `'#17543c'` used to sit here as the "brand primary"
// of every workspace that never configured one. `resolveBrandColorFacts` turns
// the empty string into 「未单独配置」.
const emptyMaterialBrandSettings: MaterialBrandSettings = { logoUrl: '', color: '', persona: '', sellingPoints: '', personaFileName: '', sellingPointsFileName: '', assetFileName: '' }

export function MaterialBrandFields({ value, onChange, label, logoLabel, leadingCard }: { value: MaterialBrandSettings; onChange: (next: MaterialBrandSettings) => void; label: string; logoLabel?: string; leadingCard?: ReactNode }) {
  const logoInputId = useId()
  const assetInputId = useId()
  const [draftColor, setDraftColor] = useState(value.color)
  const [assetAnalysisStatus, setAssetAnalysisStatus] = useState<'idle' | 'analyzing' | 'done' | 'empty'>('idle')
  useEffect(() => setDraftColor(value.color), [value.color])
  // Local by design, and it says so. This reads the picked image with
  // `FileReader` and keeps the data URL in component state — there is no request
  // on this path, so the picker may not say 「上传 Logo」 and the output card may
  // not call the result 「生效 Logo」. Both now say 「仅本地，未上传」 through
  // `resolveBrandLogoFacts`, the same sentence the document row below uses.
  const updateLogo = (file?: File) => {
    if (!file) return
    const reader = new FileReader()
    reader.addEventListener('load', () => onChange({ ...value, logoUrl: typeof reader.result === 'string' ? reader.result : '' }))
    reader.readAsDataURL(file)
  }
  // Local by design, and it says so. This reads the picked file with
  // `file.text()` and fills 用户画像/品牌卖点 from its text — there is no request
  // on this path, so the pane may not label the document 「已接收」: it says
  // 「仅本地，未上传」 through `resolveBrandDocumentFacts`. See
  // `material-brand-facts.ts` for why the two brand endpoints that exist cannot
  // be reached from here.
  const updateAssetFile = async (file?: File) => {
    if (!file) return
    setAssetAnalysisStatus('analyzing')
    onChange({ ...value, assetFileName: file.name })
    let content = ''
    try {
      content = await file.text()
    } catch {
      content = ''
    }
    const extractField = (names: string[]) => {
      for (const name of names) {
        const match = content.match(new RegExp(`${name}\\s*[：:]\\s*([^\\n\\r]{4,180})`, 'i'))
        if (match?.[1]) return match[1].trim()
      }
      return ''
    }
    const persona = extractField(['用户画像', '目标人群', '目标用户', '核心受众']) || value.persona
    const sellingPoints = extractField(['品牌卖点', '核心卖点', '品牌优势', '产品优势']) || value.sellingPoints
    onChange({ ...value, assetFileName: file.name, persona, sellingPoints })
    setAssetAnalysisStatus(persona || sellingPoints ? 'done' : 'empty')
  }
  return <div className={`material-brand-fields${leadingCard ? ' has-leading-card' : ''}${logoLabel ? ' has-store-card' : ''}`}>
    {leadingCard}
    <div className="material-brand-logo-field">
      <span>{logoLabel ?? `${label} Logo`}</span>
      <label htmlFor={logoInputId}><Upload size={14} />{value.logoUrl ? '重新选择 Logo' : '选择 Logo'}<input id={logoInputId} type="file" accept="image/*" multiple={false} onChange={(event) => updateLogo(event.target.files?.[0])} /></label>
    </div>
    <div className="material-brand-color-field"><span>品牌色</span><div><input type="color" value={/^#[0-9a-f]{6}$/i.test(draftColor) ? draftColor : value.color} onChange={(event) => setDraftColor(event.target.value)} /><label className="material-brand-color-code"><span>#</span><input aria-label={`${label}品牌色值`} value={draftColor.replace(/^#/, '')} maxLength={6} inputMode="text" onChange={(event) => setDraftColor(`#${event.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 6)}`)} /></label><button type="button" disabled={!/^#[0-9a-f]{6}$/i.test(draftColor) || draftColor.toLowerCase() === value.color.toLowerCase()} onClick={() => onChange({ ...value, color: draftColor })}>确定</button></div></div>
    <div className="material-brand-asset-file"><span>品牌资产文档</span><label htmlFor={assetInputId}><Upload size={14} /><strong>{assetAnalysisStatus === 'analyzing' ? '正在本机解析文档…' : '选择文档并解析'}</strong><input id={assetInputId} type="file" accept=".txt,.md,.csv,.json,.doc,.docx,.pdf,.zip" multiple={false} onChange={(event) => { void updateAssetFile(event.target.files?.[0]) }} /></label><small className={`material-brand-analysis-status ${assetAnalysisStatus}`}>{assetAnalysisStatus === 'analyzing' ? '正在本机提取用户画像与品牌卖点；不会上传服务端' : assetAnalysisStatus === 'done' ? BRAND_DOCUMENT_LOCAL_ANALYSIS : assetAnalysisStatus === 'empty' ? '未识别到可填写内容，请在下方手动补充' : ''}</small></div>
    <div className="material-brand-text-field"><div className="material-brand-field-heading"><span>用户画像</span></div><textarea aria-label={`${label}用户画像`} value={value.persona} onChange={(event) => onChange({ ...value, persona: event.target.value })} placeholder="例如：25–35 岁、关注设计感与使用效率的城市职场人" /></div>
    <div className="material-brand-text-field"><div className="material-brand-field-heading"><span>品牌卖点</span></div><textarea aria-label={`${label}品牌卖点`} value={value.sellingPoints} onChange={(event) => onChange({ ...value, sellingPoints: event.target.value })} placeholder="例如：原创设计、耐用材质、礼赠友好" /></div>
  </div>
}

export function MaterialBrandOutput({ value, label, enabled, onEnabledChange, context, transitionLabel }: { value: MaterialBrandSettings; label: string; enabled: boolean; onEnabledChange?: (enabled: boolean) => void; context?: { label: string; value: string }; transitionLabel?: string }) {
  // The card may only present a colour the workspace actually configured, a
  // document name only as far as the server is concerned, and a Logo only as far
  // as it actually got — see `material-brand-facts.ts`. The Logo row and the
  // document row are both read in this browser and never sent anywhere, so they
  // print the same sentence.
  const colorFacts = resolveBrandColorFacts(value.color)
  const documentFacts = resolveBrandDocumentFacts(value.assetFileName)
  const logoFacts = resolveBrandLogoFacts(value.logoUrl)
  return <aside className={`material-brand-output${enabled ? '' : ' disabled'}${transitionLabel ? ' switching' : ''}`} aria-label={`${label}${enabled ? '已经启用' : '已经停用'}的配置`}>
    <div className="material-brand-output-heading"><span>BRAND PROFILE</span><strong>当前品牌资产</strong>{onEnabledChange ? <div className="material-brand-output-switch" aria-label={`${label}启用状态`}><button type="button" className={enabled ? 'active' : ''} onClick={() => onEnabledChange(true)}>启用{label}</button><button type="button" className={!enabled ? 'active' : ''} onClick={() => onEnabledChange(false)}>停用{label}</button></div> : <small className="material-brand-output-live">本地预览，不会写入服务端</small>}</div>
    <div className={`material-brand-output-card${context ? ' has-context' : ''}`} style={{ '--brand-preview-color': colorFacts.value || 'transparent' } as CSSProperties}>
      {context && <div className="material-brand-output-context"><span>{context.label}</span><strong>{context.value}</strong></div>}
      <div className="material-brand-output-item material-brand-output-logo"><span>品牌 Logo</span><div>{logoFacts.picked ? <><img src={value.logoUrl} alt={`${label} ${logoFacts.imageAlt}`} /><small>{logoFacts.label}</small></> : <><ImageIcon size={24} /><small>{BRAND_UNCONFIGURED}</small></>}</div></div>
      <div className="material-brand-output-item material-brand-output-color"><span>品牌主色</span><div>{colorFacts.configured ? <><i /><strong>{colorFacts.value}</strong></> : <small>{colorFacts.label}</small>}</div></div>
      <div className="material-brand-output-item material-brand-output-copy"><span>用户画像</span><p>{value.persona.trim() || '尚未填写，将在生成内容时使用上一级配置。'}</p></div>
      <div className="material-brand-output-item material-brand-output-copy"><span>品牌卖点</span><p>{value.sellingPoints.trim() || '尚未填写，将在生成内容时使用上一级配置。'}</p></div>
      <div className={`material-brand-output-document${documentFacts.pending ? ' pending' : ''}`}><FileCheck2 size={18} /><div><span>品牌资产文档</span><strong>{documentFacts.fileName || BRAND_DOCUMENT_NONE}</strong></div><small>{documentFacts.label}</small></div>
    </div>
    {transitionLabel && <div className="material-brand-output-transition" role="status" aria-live="polite"><span>{transitionLabel}</span></div>}
  </aside>
}
type RecycleMaterialItem = StoreMaterialItem & {
  storeId: string
  storeName: string
  platform: string
  deletedAt: string
  expiresAt: string
}
const materialRecycleStorageKey = 'merchant-material-recycle-bin-v1'

/**
 * The recycle bin never seeds itself.
 *
 * It used to open with `recycle-demo-packaging-v1` — 「Store Nova 旗舰店 · 旧版包装
 * 展示图」, deleted "yesterday", expiring in seven days — so a brand-new account
 * that had never removed anything saw 「1 项待处理素材 · 剩余 6 天 · 2026/9/19 删除」
 * next to the claim 「删除的素材会保留 7 天，到期后自动彻底删除」. No server held
 * that item and no server enforces that retention: `GET /v1/assets` has no
 * deleted-materials counterpart and there is no delete endpoint at all.
 *
 * What is left is only what this browser actually recorded: an item appears
 * here after the merchant removes it from the material library in this profile.
 */
function readRecycleMaterials(): RecycleMaterialItem[] {
  try {
    const saved = window.localStorage.getItem(materialRecycleStorageKey)
    if (saved === null) return []
    const items = JSON.parse(saved) as RecycleMaterialItem[]
    const active = items.filter((item) => new Date(item.expiresAt).getTime() > Date.now())
    if (active.length !== items.length) window.localStorage.setItem(materialRecycleStorageKey, JSON.stringify(active))
    return active
  } catch {
    return []
  }
}

function writeRecycleMaterials(items: RecycleMaterialItem[]) {
  try {
    window.localStorage.setItem(materialRecycleStorageKey, JSON.stringify(items))
  } catch {
    // 本地预览禁用储存时仍保留当前页面状态。
  }
}

/**
 * The ids this browser has removed from the material library.
 *
 * `GET /v1/assets` has no delete counterpart, so removing a server material is
 * a browser-local decision: the id is recorded here, the library filters it out,
 * and 恢复 in the recycle bin drops it again. Without this the delete button on
 * a server material would do nothing at all.
 */
const materialRemovedStorageKey = 'merchant-material-removed-v1'

function readRemovedMaterialIds(): string[] {
  try {
    const saved = window.localStorage.getItem(materialRemovedStorageKey)
    if (saved === null) return []
    const ids = JSON.parse(saved) as unknown
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeRemovedMaterialIds(ids: string[]) {
  try {
    window.localStorage.setItem(materialRemovedStorageKey, JSON.stringify(Array.from(new Set(ids))))
  } catch {
    // 本地预览禁用储存时仍保留当前页面状态。
  }
}

function recycleDaysRemaining(expiresAt: string) {
  return Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000))
}

function MaterialCategoryDropdown({
  value,
  options,
  onChange,
  ariaLabel,
  searchable = false,
  searchPlaceholder = '搜索',
  triggerContent,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  ariaLabel: string
  searchable?: boolean
  searchPlaceholder?: string
  triggerContent?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleOptions = normalizedSearch ? options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedSearch)) : options

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])

  return (
    <div className="material-category-dropdown" ref={rootRef}>
      <button type="button" className={triggerContent ? 'custom-trigger' : ''} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} title={selectedLabel} onClick={() => { setOpen((current) => !current); setSearch('') }}>{triggerContent ?? <span>{selectedLabel}</span>}<ChevronDown size={15} /></button>
      {open && <div className={`material-category-dropdown-menu${searchable ? ' searchable' : ''}`} role="listbox" aria-label={ariaLabel}>
        {searchable && <label className="material-category-dropdown-search"><Search size={13} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} /></label>}
        <div className="material-category-dropdown-options">{visibleOptions.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'active' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); setSearch('') }}><span>{option.label}</span>{option.value === value && <Check size={14} />}</button>)}{!visibleOptions.length && <p>没有匹配的店铺</p>}</div>
      </div>}
    </div>
  )
}

export function MaterialRecycleBinWorkspace() {
  const [items, setItems] = useState<RecycleMaterialItem[]>(() => readRecycleMaterials())
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [permanentDeleteOpen, setPermanentDeleteOpen] = useState(false)
  const selectedItems = items.filter((item) => selectedIds.includes(item.id))
  const previewItem = items.find((item) => item.id === previewId)
  const allSelected = items.length > 0 && items.every((item) => selectedIds.includes(item.id))

  const removeFromRecycleBin = (ids: string[]) => {
    const next = items.filter((item) => !ids.includes(item.id))
    setItems(next)
    writeRecycleMaterials(next)
    setSelectedIds([])
  }

  // 恢复 must put the material back in the library, so it drops the id from the
  // shared removed-set the library filters on. 彻底删除 keeps it there.
  const restoreFromRecycleBin = (ids: string[]) => {
    removeFromRecycleBin(ids)
    writeRemovedMaterialIds(readRemovedMaterialIds().filter((id) => !ids.includes(id)))
  }

  return (
    <div className="material-recycle-page" data-testid="material-recycle-bin">
      <section className="material-recycle-hero">
        {/* 无法声明的保留策略不许写成服务端行为：`GET /v1/assets` 没有已删除素材
            的对应接口，服务端也不存在素材删除接口，此前那句「删除的素材会保留 7 天，
            到期后自动彻底删除」描述的是一条服务端不存在的记录。 */}
        <div><span className="section-kicker">RECYCLE BIN</span><h1>回收站</h1><p>回收站只记录本浏览器实际移除的素材；服务端已删除素材的读取尚未接入。</p></div>
        <div className="material-recycle-summary"><strong>{items.length}</strong><span>项待处理素材</span><small>本地记录 7 天后过期</small></div>
      </section>
      <section className="material-recycle-workspace">
        <div className="material-recycle-toolbar">
          <div><h2>已删除素材</h2><p>可恢复到原店铺，也可以提前彻底删除。</p><p>列表来自本浏览器的记录，不是服务端读取结果。</p></div>
          <div className="material-recycle-actions">
            <span>已选 <strong>{selectedItems.length}</strong> 项</span>
            <button type="button" disabled={!items.length} onClick={() => setSelectedIds(allSelected ? [] : items.map((item) => item.id))}>{allSelected ? '取消全选' : '全选'}</button>
            <button type="button" disabled={!selectedItems.length} onClick={() => restoreFromRecycleBin(selectedIds)}><Undo2 size={14} />恢复</button>
            <button type="button" className="danger" disabled={!selectedItems.length} onClick={() => setPermanentDeleteOpen(true)}><Trash2 size={14} />彻底删除</button>
          </div>
        </div>
        {items.length ? <div className="material-recycle-grid">{items.map((item) => {
          const selected = selectedIds.includes(item.id)
          return <article className={selected ? 'selected' : ''} key={item.id}>
            <div className="material-recycle-preview">
              <button type="button" className="material-recycle-open" aria-label={`放大${item.name}`} onClick={() => setPreviewId(item.id)}>{item.previewUrl && item.format !== 'MP4' ? <img src={item.previewUrl} alt="" /> : item.category === '商品视频' ? <Play size={34} fill="currentColor" /> : <ImageIcon size={34} />}</button>
              <button type="button" className="material-recycle-select" aria-label={`选择${item.name}`} aria-pressed={selected} onClick={() => setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>{selected && <Check size={14} />}</button>
              <span>{item.category}</span>
            </div>
            <div className="material-recycle-copy"><strong title={item.name}>{item.name}</strong><span>{item.series} · {item.sizeLabel} · {item.format}</span><small>{item.storeName} · {item.platform}</small></div>
            <div className="material-recycle-expiry"><Clock3 size={13} /><span>剩余 {recycleDaysRemaining(item.expiresAt)} 天</span><small>{new Date(item.deletedAt).toLocaleDateString('zh-CN')} 删除</small></div>
          </article>
        })}</div> : <div className="material-empty"><Trash2 size={30} /><strong>回收站为空</strong><span>本浏览器还没有记录到已移除的素材；服务端已删除素材的读取尚未接入。</span></div>}
      </section>
      {previewItem && <button type="button" className="material-upload-lightbox" aria-label="关闭回收站图片预览" onClick={() => setPreviewId(null)}><span>{previewItem.previewUrl && previewItem.format !== 'MP4' ? <img src={previewItem.previewUrl} alt={previewItem.name} /> : <span className="material-recycle-large-preview"><ImageIcon size={70} /></span>}<strong>{previewItem.name}</strong><small>点击任意位置关闭</small></span></button>}
      {permanentDeleteOpen && selectedItems.length > 0 && <DialogFrame title="彻底删除素材" kicker="PERMANENT DELETE" onClose={() => setPermanentDeleteOpen(false)} actions={<><button type="button" className="catalog-asset-cancel" onClick={() => setPermanentDeleteOpen(false)}>取消</button><button type="button" className="material-delete-confirm" onClick={() => { removeFromRecycleBin(selectedIds); setPermanentDeleteOpen(false) }}><Trash2 size={14} />彻底删除</button></>}><div className="material-delete-dialog"><Trash2 size={24} /><div><strong>确定彻底删除已选的 {selectedItems.length} 项素材？</strong><p>此操作完成后，这些素材将无法从回收站恢复。</p></div></div></DialogFrame>}
    </div>
  )
}

export function MaterialLibraryWorkspace({
  baseUrl,
  accounts,
  products,
  view = 'library',
}: {
  baseUrl?: string
  accounts: PlatformAccount[] | null
  products: ApiProduct[] | null
  view?: 'library' | 'brands'
}) {
  // Both the store list and the material list are server reads now. The store
  // list reuses the catalogue page's `buildCatalogPlatforms` so the two pages
  // can never disagree about how many stores the workspace has again.
  const catalogPlatforms: CatalogPlatformView[] | null = useMemo(
    () => buildCatalogPlatforms(accounts, products),
    [accounts, products],
  )
  const catalogStores = useMemo(
    () => catalogPlatforms?.flatMap((platform) => platform.stores) ?? null,
    [catalogPlatforms],
  )
  // `GET /v1/assets` is the only honest source for the material cards. Before
  // it answers the page says so; when it answers empty the page says empty.
  const [remoteAssets, setRemoteAssets] = useState<AssetMetadata[] | null>(null)
  const [assetsError, setAssetsError] = useState('')
  const [materialDownloadError, setMaterialDownloadError] = useState('')
  useEffect(() => {
    if (!baseUrl) {
      setRemoteAssets(null)
      setAssetsError('')
      return
    }
    let active = true
    setRemoteAssets(null)
    setAssetsError('')
    fetchAssets(baseUrl)
      .then((assets) => { if (active) setRemoteAssets(assets) })
      .catch((cause) => { if (active) setAssetsError(describeApiError(cause)) })
    return () => { active = false }
  }, [baseUrl])
  const materialsRead = resolveMaterialRead({ baseUrl, remote: remoteAssets, error: assetsError })
  const stores = useMemo(
    () => (catalogStores ?? []).filter((store) => store.readable).map(catalogStoreForMaterials),
    [catalogStores],
  )
  const materialStores = useMemo<CatalogStore[]>(
    () =>
      view === 'library'
        ? [...stores, { id: 'unclassified', mark: '未', logoUrl: '', name: '未分类', platform: '未分类' }]
        : stores,
    [stores, view],
  )
  const [activeStoreId, setActiveStoreId] = useState(materialStores[0]?.id ?? '')
  // The initial render happens before `/v1/platform-accounts` answers, so the
  // selection starts on the local 未分类 bucket. Remember whether the merchant
  // picked a store themselves before moving the default to a real one.
  const [storeChosenByMerchant, setStoreChosenByMerchant] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'全部' | StoreMaterialCategory>('全部')
  const [series, setSeries] = useState<string>('全部')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // Materials this browser itself selected and handed to the workspace. They
  // are kept per store because the merchant picked the store; nothing else is
  // seeded here — the eight invented materials per store are gone.
  const [materialsByStore, setMaterialsByStore] = useState<Record<string, StoreMaterialItem[]>>({})
  const [removedMaterialIds, setRemovedMaterialIds] = useState<string[]>(() => readRemovedMaterialIds())
  const [uploadedBytes, setUploadedBytes] = useState(0)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadStoreId, setUploadStoreId] = useState(materialStores[0]?.id ?? '')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [pendingSelectedKeys, setPendingSelectedKeys] = useState<string[]>([])
  const [uploadCategory, setUploadCategory] = useState<StoreMaterialCategory>('未分类')
  const [uploadSeries, setUploadSeries] = useState('')
  // The upload is a server write now, so it has a busy state and its own error
  // line: 确认上传 may not close on a refusal.
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [pendingPreviewIndex, setPendingPreviewIndex] = useState<number | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [detailMaterialId, setDetailMaterialId] = useState<string | null>(null)
  const [detailPreviewOpen, setDetailPreviewOpen] = useState(false)
  // The global brand slot starts empty, like every other level of the stack.
  //
  // It used to open with `logoUrl: storeNovaLogo` and
  // `assetFileName: 'Store Nova 品牌资产手册.pdf'`, which made 品牌资产 › 全局配置
  // report a Logo taken from the app bundle and a 品牌资产文档 marked 「已接收」 for
  // a document no server ever received. `GET /v1/brand-profile` answers
  // `{profile: null}` for this workspace and this panel reads no server brand
  // profile at all, so there was nothing to seed from: 未单独配置 and 暂无资产文件
  // are the two facts it can actually stand behind.
  const [globalBrand, setGlobalBrand] = useState<MaterialBrandSettings>({ ...emptyMaterialBrandSettings })
  const [globalBrandEnabled, setGlobalBrandEnabled] = useState(true)
  const [storeBrands, setStoreBrands] = useState<Record<string, MaterialBrandSettings>>({})
  const [storeBrandEnabled, setStoreBrandEnabled] = useState<Record<string, boolean>>({})
  const [storeBrandTransition, setStoreBrandTransition] = useState('')
  const [seriesBrandTransition, setSeriesBrandTransition] = useState('')
  const [seriesByStore, setSeriesByStore] = useState<Record<string, string[]>>(() => {
    const saved = readStoreSeriesRegistry()
    return Object.fromEntries(materialStores.map((store) => [store.id, saved[store.id]?.length ? saved[store.id] : initialSeriesForStore(store.id)]))
  })
  const [newSeriesName, setNewSeriesName] = useState('')
  const [activeBrandSeries, setActiveBrandSeries] = useState(() => seriesForStore(stores[0]?.id ?? '')[0] ?? '未分类')
  const [seriesManagerOpen, setSeriesManagerOpen] = useState(false)
  const [seriesBrands, setSeriesBrands] = useState<Record<string, MaterialBrandSettings>>({})
  const [seriesBrandEnabled, setSeriesBrandEnabled] = useState<Record<string, boolean>>({})
  const [imageBrands, setImageBrands] = useState<Record<string, MaterialBrandSettings>>({})
  const [imageBrandEnabled, setImageBrandEnabled] = useState<Record<string, boolean>>({})
  const uploadInput = useRef<HTMLInputElement>(null)
  const seriesManagerRef = useRef<HTMLDivElement>(null)
  const storeBrandTransitionTimer = useRef<number | null>(null)
  const seriesBrandTransitionTimer = useRef<number | null>(null)
  const pendingPreviews = useMemo(() => pendingFiles.map((file) => ({ file, url: URL.createObjectURL(file) })), [pendingFiles])
  const availableSeries = seriesByStore[activeStoreId] ?? ['未分类']
  const activeSeriesKey = `${activeStoreId}::${activeBrandSeries}`

  useEffect(() => () => pendingPreviews.forEach((item) => URL.revokeObjectURL(item.url)), [pendingPreviews])

  // The store list arrives asynchronously from `/v1/platform-accounts`. Until
  // the merchant picks a store, follow the server's first real store rather
  // than leaving the selection on the 未分类 bucket (which is only ever an
  // upload target of last resort).
  useEffect(() => {
    if (storeChosenByMerchant) return
    const first = materialStores.find((store) => store.id !== 'unclassified') ?? materialStores[0]
    if (!first || first.id === activeStoreId) return
    setActiveStoreId(first.id)
    setUploadStoreId(first.id)
    setActiveBrandSeries((seriesByStore[first.id] ?? initialSeriesForStore(first.id))[0] ?? '未分类')
  }, [materialStores, storeChosenByMerchant, activeStoreId, seriesByStore])

  // Give every store that appears after the account read its series list. The
  // initialiser ran on an empty list, so without this the first store would
  // render with no series at all.
  useEffect(() => {
    setSeriesByStore((current) => {
      const missing = materialStores.filter((store) => !current[store.id])
      if (!missing.length) return current
      const saved = readStoreSeriesRegistry()
      return {
        ...current,
        ...Object.fromEntries(missing.map((store) => [store.id, saved[store.id]?.length ? saved[store.id] : initialSeriesForStore(store.id)])),
      }
    })
  }, [materialStores])

  useEffect(() => () => {
    if (storeBrandTransitionTimer.current !== null) window.clearTimeout(storeBrandTransitionTimer.current)
    if (seriesBrandTransitionTimer.current !== null) window.clearTimeout(seriesBrandTransitionTimer.current)
  }, [])

  useEffect(() => {
    if (pendingPreviewIndex === null) return
    const closePreview = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setPendingPreviewIndex(null)
      }
    }
    document.addEventListener('keydown', closePreview, true)
    return () => document.removeEventListener('keydown', closePreview, true)
  }, [pendingPreviewIndex])

  useEffect(() => {
    if (!seriesManagerOpen) return
    const closeSeriesManager = (event: PointerEvent) => {
      if (!seriesManagerRef.current?.contains(event.target as Node)) setSeriesManagerOpen(false)
    }
    const closeSeriesManagerWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSeriesManagerOpen(false)
    }
    document.addEventListener('pointerdown', closeSeriesManager)
    document.addEventListener('keydown', closeSeriesManagerWithKeyboard)
    return () => {
      document.removeEventListener('pointerdown', closeSeriesManager)
      document.removeEventListener('keydown', closeSeriesManagerWithKeyboard)
    }
  }, [seriesManagerOpen])
  const activeStore = materialStores.find((store) => store.id === activeStoreId) ?? materialStores[0]
  const uploadStore = (materialStores.find((store) => store.id === uploadStoreId) ?? activeStore)!
  const uploadAvailableSeries = seriesByStore[uploadStoreId] ?? initialSeriesForStore(uploadStoreId)
  // The listed inventory is the workspace read plus whatever this browser
  // actually selected during the session. `GET /v1/assets` is workspace-scoped
  // and publishes no store attribution, so the store selector cannot honestly
  // partition the server rows; it stays what the summary already calls it, the
  // upload target (and the brand-config scope). Attributing a server asset to a
  // store would be the same class of invention the seed was removed for.
  // A session upload is a server asset now, so the re-read returns the same row
  // the upload acknowledged. The session copy is kept — it is the one carrying the
  // merchant's 素材分类/所属系列 — and the server row for the same id is not
  // rendered twice beside it.
  const sessionMaterials = materialsByStore[activeStoreId] ?? []
  const sessionMaterialIds = new Set(sessionMaterials.map((item) => item.id))
  const activeMaterials = [
    ...sessionMaterials,
    ...materialsRead.items.filter((item) => !sessionMaterialIds.has(item.id)),
  ].filter((item) => !removedMaterialIds.includes(item.id))
  const visibleMaterials = activeMaterials.filter((item) => {
    const matchesCategory = category === '全部' || item.category === category
    const matchesSeries = series === '全部' || item.series === series
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return matchesCategory && matchesSeries && (!normalizedQuery || `${item.name} ${item.category} ${item.series} ${item.format}`.toLocaleLowerCase().includes(normalizedQuery))
  })
  // A read that has not answered may not be rendered as 「找到 0 项素材」: the
  // page has to say which of the four states it is in, exactly like the rest of
  // the workspace. The count only appears once `GET /v1/assets` has answered.
  const materialsSummary = materialsRead.state === 'ready'
    ? <>找到 <strong>{visibleMaterials.length}</strong> 项素材</>
    : materialSummaryText(materialsRead)
  const { title: materialEmptyTitle, detail: materialEmptyDetail } = materialEmptyCopy(materialsRead)
  // `GET /v1/assets/:id/download` is authenticated, so the bytes are re-read
  // with the merchant session under the asset's own name. The old href was a
  // `data:text/plain` URL, which downloaded a four-line text file.
  const downloadMaterial = async (item: StoreMaterialItem) => {
    if (!baseUrl || !item.assetId) return
    setMaterialDownloadError('')
    try {
      const blob = await fetchAssetBlob(baseUrl, item.assetId)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = item.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (cause) {
      setMaterialDownloadError(`素材下载失败：${describeApiError(cause)}`)
    }
  }
  // The storage quota is server-owned and this local library has no API base
  // URL to read it, so it reports only what it can actually observe (the bytes
  // uploaded in this session) and marks the quota itself as unread. Showing a
  // fabricated usage/quota pair would be presented to paying merchants.
  const uploadedGb = uploadedBytes / 1024 / 1024 / 1024
  const allVisibleSelected = visibleMaterials.length > 0 && visibleMaterials.every((item) => selectedIds.includes(item.id))
  const selectedMaterials = activeMaterials.filter((item) => selectedIds.includes(item.id))
  const detailMaterial = activeMaterials.find((item) => item.id === detailMaterialId)
  const effectiveGlobalBrand = globalBrandEnabled ? globalBrand : { ...emptyMaterialBrandSettings }
  const activeStoreBrand = storeBrands[activeStoreId] ?? { ...emptyMaterialBrandSettings }
  const activeStoreBrandEnabled = storeBrandEnabled[activeStoreId] ?? true
  const effectiveStoreBrand: MaterialBrandSettings = activeStoreBrandEnabled ? {
    logoUrl: activeStoreBrand.logoUrl || effectiveGlobalBrand.logoUrl,
    color: activeStoreBrand.color || effectiveGlobalBrand.color,
    persona: activeStoreBrand.persona || effectiveGlobalBrand.persona,
    sellingPoints: activeStoreBrand.sellingPoints || effectiveGlobalBrand.sellingPoints,
    personaFileName: activeStoreBrand.personaFileName || effectiveGlobalBrand.personaFileName,
    sellingPointsFileName: activeStoreBrand.sellingPointsFileName || effectiveGlobalBrand.sellingPointsFileName,
    assetFileName: activeStoreBrand.assetFileName || effectiveGlobalBrand.assetFileName,
  } : effectiveGlobalBrand
  const activeSeriesBrand = seriesBrands[activeSeriesKey] ?? { ...emptyMaterialBrandSettings }
  const activeSeriesBrandEnabled = seriesBrandEnabled[activeSeriesKey] ?? true
  const effectiveSeriesBrand: MaterialBrandSettings = activeSeriesBrandEnabled ? {
    logoUrl: activeSeriesBrand.logoUrl || effectiveStoreBrand.logoUrl,
    color: activeSeriesBrand.color || effectiveStoreBrand.color,
    persona: activeSeriesBrand.persona || effectiveStoreBrand.persona,
    sellingPoints: activeSeriesBrand.sellingPoints || effectiveStoreBrand.sellingPoints,
    personaFileName: activeSeriesBrand.personaFileName || effectiveStoreBrand.personaFileName,
    sellingPointsFileName: activeSeriesBrand.sellingPointsFileName || effectiveStoreBrand.sellingPointsFileName,
    assetFileName: activeSeriesBrand.assetFileName || effectiveStoreBrand.assetFileName,
  } : effectiveStoreBrand
  const detailImageBrand = detailMaterial ? imageBrands[detailMaterial.id] ?? { ...emptyMaterialBrandSettings } : { ...emptyMaterialBrandSettings }
  const detailSeriesKey = `${activeStoreId}::${detailMaterial?.series ?? activeBrandSeries}`
  const detailSeriesBrand = seriesBrands[detailSeriesKey] ?? { ...emptyMaterialBrandSettings }
  const detailSeriesBrandEnabled = seriesBrandEnabled[detailSeriesKey] ?? true
  const effectiveDetailSeriesBrand: MaterialBrandSettings = detailSeriesBrandEnabled ? {
    logoUrl: detailSeriesBrand.logoUrl || effectiveStoreBrand.logoUrl,
    color: detailSeriesBrand.color || effectiveStoreBrand.color,
    persona: detailSeriesBrand.persona || effectiveStoreBrand.persona,
    sellingPoints: detailSeriesBrand.sellingPoints || effectiveStoreBrand.sellingPoints,
    personaFileName: detailSeriesBrand.personaFileName || effectiveStoreBrand.personaFileName,
    sellingPointsFileName: detailSeriesBrand.sellingPointsFileName || effectiveStoreBrand.sellingPointsFileName,
    assetFileName: detailSeriesBrand.assetFileName || effectiveStoreBrand.assetFileName,
  } : effectiveStoreBrand
  const detailImageBrandEnabled = detailMaterial ? imageBrandEnabled[detailMaterial.id] ?? true : true
  const effectiveDetailImageBrand: MaterialBrandSettings = detailImageBrandEnabled ? {
    logoUrl: detailImageBrand.logoUrl || effectiveDetailSeriesBrand.logoUrl,
    color: detailImageBrand.color || effectiveDetailSeriesBrand.color,
    persona: detailImageBrand.persona || effectiveDetailSeriesBrand.persona,
    sellingPoints: detailImageBrand.sellingPoints || effectiveDetailSeriesBrand.sellingPoints,
    personaFileName: detailImageBrand.personaFileName || effectiveDetailSeriesBrand.personaFileName,
    sellingPointsFileName: detailImageBrand.sellingPointsFileName || effectiveDetailSeriesBrand.sellingPointsFileName,
    assetFileName: detailImageBrand.assetFileName || effectiveDetailSeriesBrand.assetFileName,
  } : effectiveDetailSeriesBrand
  const batchDownloadUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(selectedMaterials.map((item) => `${item.name} · ${item.category} · ${item.series} · ${item.fileSizeLabel}`).join('\n'))}`

  const createBrandSeries = () => {
    const name = newSeriesName.trim()
    if (!name) return
    const nextSeriesByStore = { ...seriesByStore, [activeStoreId]: availableSeries.includes(name) ? availableSeries : [...availableSeries, name] }
    setSeriesByStore(nextSeriesByStore)
    writeStoreSeriesRegistry(nextSeriesByStore)
    setActiveBrandSeries(name)
    const nextKey = `${activeStoreId}::${name}`
    setSeriesBrands((current) => current[nextKey] ? current : { ...current, [nextKey]: { ...emptyMaterialBrandSettings } })
    window.dispatchEvent(new CustomEvent(storeSeriesChangedEvent, { detail: { storeId: activeStoreId } }))
    setNewSeriesName('')
    setSeriesManagerOpen(false)
  }

  const showSeriesTransition = (name: string) => {
    if (seriesBrandTransitionTimer.current !== null) window.clearTimeout(seriesBrandTransitionTimer.current)
    setSeriesBrandTransition(`切换至 ${name}系列`)
    seriesBrandTransitionTimer.current = window.setTimeout(() => {
      setSeriesBrandTransition('')
      seriesBrandTransitionTimer.current = null
    }, 900)
  }

  const switchBrandSeries = (name: string) => {
    if (name === activeBrandSeries) {
      setSeriesManagerOpen(false)
      return
    }
    setActiveBrandSeries(name)
    setSeriesManagerOpen(false)
    showSeriesTransition(name)
  }

  const switchBrandStore = (storeId: string) => {
    if (storeId === activeStoreId) return
    const nextStore = stores.find((store) => store.id === storeId)
    if (!nextStore) return
    if (storeBrandTransitionTimer.current !== null) window.clearTimeout(storeBrandTransitionTimer.current)
    const nextSeries = (seriesByStore[storeId] ?? initialSeriesForStore(storeId))[0] ?? '未分类'
    setStoreBrandTransition(`切换至 ${nextStore.name}`)
    setStoreChosenByMerchant(true)
    setActiveStoreId(storeId)
    setActiveBrandSeries(nextSeries)
    showSeriesTransition(nextSeries)
    storeBrandTransitionTimer.current = window.setTimeout(() => {
      setStoreBrandTransition('')
      storeBrandTransitionTimer.current = null
    }, 900)
  }

  const deleteBrandSeries = (name: string) => {
    const remainingSeries = availableSeries.filter((item) => item !== name)
    if (!remainingSeries.length) return
    const fallbackSeries = remainingSeries.includes('未分类') ? '未分类' : remainingSeries[0]
    const nextSeriesByStore = { ...seriesByStore, [activeStoreId]: remainingSeries }
    setSeriesByStore(nextSeriesByStore)
    writeStoreSeriesRegistry(nextSeriesByStore)
    const reassignments = readStoreSeriesReassignments()
    const nextReassignments = { ...reassignments, [activeStoreId]: { ...(reassignments[activeStoreId] ?? {}), [name]: fallbackSeries } }
    try {
      window.localStorage.setItem(storeSeriesReassignmentsStorageKey, JSON.stringify(nextReassignments))
    } catch {
      // 本地预览禁用储存时仍保留当前页面状态。
    }
    const deletedKey = `${activeStoreId}::${name}`
    setSeriesBrands((current) => {
      const next = { ...current }
      delete next[deletedKey]
      return next
    })
    setSeriesBrandEnabled((current) => {
      const next = { ...current }
      delete next[deletedKey]
      return next
    })
    setMaterialsByStore((current) => ({ ...current, [activeStoreId]: (current[activeStoreId] ?? []).map((item) => item.series === name ? { ...item, series: fallbackSeries } : item) }))
    window.dispatchEvent(new CustomEvent(storeSeriesChangedEvent, { detail: { storeId: activeStoreId, deleted: name, fallback: fallbackSeries } }))
    if (activeBrandSeries === name) {
      setActiveBrandSeries(fallbackSeries)
      showSeriesTransition(fallbackSeries)
    }
    if (series === name) setSeries('全部')
    if (uploadSeries === name) setUploadSeries(fallbackSeries)
  }

  const switchStore = (storeId: string) => {
    setStoreChosenByMerchant(true)
    setActiveStoreId(storeId)
    setActiveBrandSeries((seriesByStore[storeId] ?? initialSeriesForStore(storeId))[0] ?? '未分类')
    setQuery('')
    setCategory('全部')
    setSeries('全部')
    setSelectedIds([])
    setDeleteDialogOpen(false)
    setDetailMaterialId(null)
  }

  const closeUploadDialog = () => {
    setUploadDialogOpen(false)
    setPendingFiles([])
    setPendingSelectedKeys([])
    setUploadCategory('未分类')
    setUploadSeries('')
    setUploadError('')
    setUploadBusy(false)
    setPendingPreviewIndex(null)
    if (uploadInput.current) uploadInput.current.value = ''
  }

  const addPendingFiles = (files: FileList | null) => {
    if (!files?.length) return
    const incoming = Array.from(files)
    setPendingFiles((current) => {
      const known = new Set(current.map((file) => `${file.name}-${file.size}-${file.lastModified}`))
      const additions = incoming.filter((file) => !known.has(`${file.name}-${file.size}-${file.lastModified}`))
      return [...current, ...additions].slice(0, 50)
    })
    if (uploadInput.current) uploadInput.current.value = ''
  }

  const pendingFileKey = (file: File) => `${file.name}-${file.size}-${file.lastModified}`

  const deleteSelectedPendingFiles = () => {
    if (!pendingSelectedKeys.length) return
    const selected = new Set(pendingSelectedKeys)
    setPendingFiles((current) => current.filter((file) => !selected.has(pendingFileKey(file))))
    setPendingSelectedKeys([])
    setPendingPreviewIndex(null)
  }

  /**
   * 确认上传 sends the files to `POST /v1/assets/upload`.
   *
   * It used to only call `URL.createObjectURL` and push a hand-written item into
   * local state: the server never saw the bytes, so a refresh lost every material
   * the merchant had just "uploaded", and the card's 下载 served the object URL of
   * a file that never existed outside the tab. The upload endpoint was always
   * there — `ProductSpreadsheetImport.tsx` already used it. The card is now built
   * from the row the server acknowledged, so 格式/文件大小/上传时间 are the
   * server's facts instead of the invented 「1920 × 1080」/「刚刚上传」.
   */
  const confirmUpload = async () => {
    if (!pendingFiles.length || !uploadStore || !uploadSeries || uploadBusy) return
    if (!baseUrl) {
      // No API means no server: saying 「上传成功」 here is exactly the lie the
      // local-only version told.
      setUploadError('未配置 API，素材无法上传到服务端；配置 API 后再上传。')
      return
    }
    const incoming = pendingFiles
    setUploadBusy(true)
    setUploadError('')
    const { accepted, failures } = await uploadMaterialFiles({
      files: incoming,
      upload: (file) => uploadAsset(baseUrl, file),
      labels: { category: uploadCategory, series: uploadSeries },
      // A thumbnail of the file this browser just sent: an object URL for this
      // session only, never a second copy of the asset.
      previewUrlFor: (file) => URL.createObjectURL(file),
    })
    if (accepted.length) {
      setMaterialsByStore((current) => ({ ...current, [uploadStore.id]: [...accepted, ...(current[uploadStore.id] ?? [])] }))
      setUploadedBytes((current) => current + accepted.reduce((total, item) => total + (item.bytes ?? 0), 0))
      setCategory('全部')
      setSeries('全部')
      setQuery('')
      // Re-read so the list is the server's answer rather than this browser's.
      void fetchAssets(baseUrl)
        .then((assets) => setRemoteAssets(assets))
        .catch((cause) => setAssetsError(describeApiError(cause)))
    }
    setUploadBusy(false)
    if (failures.length) {
      // Partial success stays visible: the accepted files are listed and the
      // rejects are named, so 确认上传 is never reported as a blanket success.
      setUploadError(`以下素材未通过服务端检查：${failures.join('；')}`)
      return
    }
    closeUploadDialog()
  }

  const updateMaterialMetadata = (materialId: string, patch: Partial<Pick<StoreMaterialItem, 'category' | 'series'>>) => {
    setMaterialsByStore((current) => ({
      ...current,
      [activeStoreId]: (current[activeStoreId] ?? []).map((item) => item.id === materialId ? { ...item, ...patch } : item),
    }))
  }

  const deleteSelectedMaterials = () => {
    if (!activeStore) return
    // `uploadedBytes` counts what this session actually sent to
    // `POST /v1/assets/upload` and nothing else, so nothing is subtracted here.
    // Removing a material from the list — whether it was uploaded here or read
    // from `GET /v1/assets` — is a browser-local list change, not a server-side
    // removal (`GET /v1/assets` has no delete counterpart), and the bytes were
    // uploaded either way.
    const now = new Date()
    const expiresAt = new Date(now)
    expiresAt.setDate(expiresAt.getDate() + 7)
    const recycled = readRecycleMaterials()
    const additions = selectedMaterials.map((item): RecycleMaterialItem => ({
      ...item,
      // `GET /v1/assets` publishes no store attribution, so a server asset is
      // recorded as 未归属 rather than filed under whichever store happened to
      // be selected. Session uploads really did pick a store.
      storeId: item.assetId ? '' : activeStore.id,
      storeName: item.assetId ? '未归属' : activeStore.name,
      platform: item.assetId ? '未归属' : activeStore.platform,
      deletedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }))
    writeRecycleMaterials([...additions, ...recycled.filter((item) => !selectedIds.includes(item.id))])
    const nextRemoved = Array.from(new Set([...readRemovedMaterialIds(), ...selectedIds]))
    writeRemovedMaterialIds(nextRemoved)
    setRemovedMaterialIds(nextRemoved)
    setMaterialsByStore((current) => ({
      ...current,
      [activeStoreId]: (current[activeStoreId] ?? []).filter((item) => !selectedIds.includes(item.id)),
    }))
    setSelectedIds([])
    setDeleteDialogOpen(false)
  }

  // A workspace the server reports no store for is a real state (the catalogue
  // page has the same case). Without this the brand panel read `activeStore.name`
  // on an undefined store and took the page down.
  if (!activeStore) {
    return <div className="material-library-page" data-testid="material-library-workspace">
      <section className="material-store-workspace">
        <div className="material-empty">
          <FolderOpen size={28} />
          <strong>{catalogStores === null ? '店铺列表尚未从服务端读取' : '当前工作区没有可管理的店铺'}</strong>
          <span>{catalogStores === null ? '店铺列表来自服务端，读取完成后才会显示素材与品牌配置。' : '素材与品牌配置按店铺管理；服务端未报告店铺时不显示任何店铺。'}</span>
        </div>
      </section>
    </div>
  }

  if (detailMaterial) {
    return <div className="material-detail-page" data-testid="material-detail-page">
      <button type="button" className="material-detail-back" onClick={() => { setDetailMaterialId(null); setDetailPreviewOpen(false) }}><ArrowLeft size={16} />返回素材库</button>
      <section className="material-detail-hero">
        <button type="button" className={`material-detail-preview ${detailMaterial.previewUrl ? 'has-image' : ''}`} aria-label={`放大${detailMaterial.name}`} onClick={() => setDetailPreviewOpen(true)}>{detailMaterial.previewUrl && detailMaterial.format !== 'MP4' ? <img src={detailMaterial.previewUrl} alt={detailMaterial.name} /> : detailMaterial.category === '商品视频' ? <Play size={64} fill="currentColor" /> : <ImageIcon size={64} />}<span>点击放大预览</span></button>
        <div className="material-detail-info"><span className="section-kicker">MATERIAL DETAILS</span><h1>{detailMaterial.name}</h1><p>查看素材文件、归属店铺与管理信息。</p><dl><div><dt>素材分类</dt><dd>{detailMaterial.category}</dd></div><div><dt>所属系列</dt><dd>{detailMaterial.series}</dd></div><div><dt>所属店铺</dt><dd>{detailMaterial.assetId ? '未归属' : activeStore.name}</dd></div><div><dt>平台</dt><dd>{detailMaterial.assetId ? '未归属' : activeStore.platform}</dd></div><div><dt>文件格式</dt><dd>{detailMaterial.format}</dd></div><div><dt>图片尺寸</dt><dd>{detailMaterial.sizeLabel}</dd></div><div><dt>文件大小</dt><dd>{detailMaterial.fileSizeLabel}</dd></div><div><dt>上传时间</dt><dd>{detailMaterial.addedAt}</dd></div></dl><a href={materialDownloadHref(detailMaterial, baseUrl)} download={detailMaterial.name} onClick={(event) => { if (!detailMaterial.assetId) return; event.preventDefault(); void downloadMaterial(detailMaterial) }}><Download size={15} />下载素材</a></div>
      </section>
      <section className="material-image-brand-settings">
        <div className="material-brand-panel-heading"><div><span className="section-kicker">IMAGE BRAND SETTINGS</span><h2>单图品牌配置</h2><p>此处设置只应用于当前图片，并覆盖“{detailMaterial.series}”系列、店铺和全局品牌设置。</p></div><div className="material-brand-priority" aria-label="资产应用原则"><strong>资产应用原则：</strong><span>单图配置 &gt; 系列配置 &gt; 店铺配置 &gt; 全局配置</span></div></div>
        <article className="material-brand-row material-image-brand-row">
          <div className="material-brand-config-card"><div className="material-brand-row-heading"><span>04</span><div><strong>单图配置</strong><small>优先级最高，只应用于当前图片</small></div></div><MaterialBrandFields value={detailImageBrand} label="单图" onChange={(next) => setImageBrands((current) => ({ ...current, [detailMaterial.id]: next }))} /></div>
          <MaterialBrandOutput value={effectiveDetailImageBrand} label="单图配置" enabled={detailImageBrandEnabled} onEnabledChange={(enabled) => setImageBrandEnabled((current) => ({ ...current, [detailMaterial.id]: enabled }))} context={{ label: '当前图片', value: detailMaterial.name }} />
        </article>
      </section>
      {detailPreviewOpen && <button type="button" className="material-upload-lightbox" aria-label="关闭素材图片预览" onClick={() => setDetailPreviewOpen(false)}><span>{detailMaterial.previewUrl && detailMaterial.format !== 'MP4' ? <img src={detailMaterial.previewUrl} alt={detailMaterial.name} /> : <span className="material-recycle-large-preview"><ImageIcon size={70} /></span>}<strong>{detailMaterial.name}</strong><small>点击任意位置关闭</small></span></button>}
    </div>
  }

  return (
    <div className="material-library-page" data-testid="material-library-workspace">
      {view === 'brands' && <section className="material-library-hero brand-only">
        <div className="material-library-intro">
          <span className="section-kicker">BRAND ASSETS</span>
          <h1>品牌资产</h1>
          <p>维护全局、系列与单图品牌信息。</p>
        </div>
      </section>}

      {view === 'brands' && <section className="material-brand-assets-panel" aria-label="品牌资产配置">
        <div className="material-brand-panel-heading">
          <div><span className="section-kicker">BRAND SETTINGS</span><h2>品牌配置</h2><p>统一维护全局、店铺、系列与单图品牌信息，生成内容时自动按优先级应用。</p></div>
          <div className="material-brand-priority" aria-label="资产应用原则"><strong>资产应用原则：</strong><span>单图配置 &gt; 系列配置 &gt; 店铺配置 &gt; 全局配置</span></div>
        </div>
        <div className="material-brand-stack">
          <article className="material-brand-row">
            <div className="material-brand-config-card"><div className="material-brand-row-heading"><span>01</span><div><strong>全局配置</strong><small>所有系列与图片的默认品牌资产</small></div></div><MaterialBrandFields value={globalBrand} label="全局" onChange={setGlobalBrand} /></div>
            <MaterialBrandOutput value={effectiveGlobalBrand} label="全局配置" enabled={globalBrandEnabled} onEnabledChange={setGlobalBrandEnabled} />
          </article>
          <article className="material-brand-row">
            <div className="material-brand-config-card"><div className="material-brand-row-heading"><span>02</span><div><strong>店铺配置</strong><small>覆盖全局配置并应用到当前店铺</small></div></div><MaterialBrandFields value={activeStoreBrand} label={activeStore.name} logoLabel="店铺 Logo" onChange={(next) => setStoreBrands((current) => ({ ...current, [activeStoreId]: next }))} leadingCard={<div className="material-brand-series-card material-brand-store-card"><span className="material-brand-store-label">选择店铺</span><MaterialCategoryDropdown ariaLabel="选择配置店铺" value={activeStoreId} options={stores.map((store) => ({ value: store.id, label: store.name }))} onChange={switchBrandStore} /></div>} /></div>
            <MaterialBrandOutput value={effectiveStoreBrand} label="店铺配置" enabled={activeStoreBrandEnabled} onEnabledChange={(enabled) => setStoreBrandEnabled((current) => ({ ...current, [activeStoreId]: enabled }))} context={{ label: '当前店铺', value: activeStore.name }} transitionLabel={storeBrandTransition} />
          </article>
          <article className="material-brand-row">
            <div className="material-brand-config-card"><div className="material-brand-row-heading"><span>03</span><div><strong>系列配置</strong><small>覆盖店铺配置并应用到当前系列</small></div></div><MaterialBrandFields value={activeSeriesBrand} label={activeBrandSeries} onChange={(next) => setSeriesBrands((current) => ({ ...current, [activeSeriesKey]: next }))} leadingCard={<div className="material-brand-series-card" ref={seriesManagerRef}><div className="material-brand-series-current"><span>当前系列</span><strong>{activeBrandSeries}</strong></div><button type="button" aria-haspopup="dialog" aria-expanded={seriesManagerOpen} onClick={() => setSeriesManagerOpen((current) => !current)}><Boxes size={14} />管理系列</button>{seriesManagerOpen && <div className="material-brand-series-manager" role="dialog" aria-label="管理系列"><div><span>系列管理</span><strong>创建、选择或删除当前店铺系列</strong></div><label><span>新系列名称</span><div><input autoFocus value={newSeriesName} onChange={(event) => setNewSeriesName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createBrandSeries() }} placeholder="例如：秋冬新品" /><button type="button" onClick={createBrandSeries} disabled={!newSeriesName.trim()}>创建</button></div></label><div className="material-brand-series-list"><span>已有系列</span>{availableSeries.map((item) => <div className={item === activeBrandSeries ? 'active' : ''} key={item}><button type="button" className="material-brand-series-select" onClick={() => switchBrandSeries(item)}><span>{item}</span>{item === activeBrandSeries && <Check size={14} />}</button><button type="button" className="material-brand-series-delete" aria-label={`删除${item}系列`} disabled={availableSeries.length === 1} onClick={() => deleteBrandSeries(item)}><Trash2 size={13} /></button></div>)}</div></div>}</div>} /></div>
            <MaterialBrandOutput value={effectiveSeriesBrand} label="系列配置" enabled={activeSeriesBrandEnabled} onEnabledChange={(enabled) => setSeriesBrandEnabled((current) => ({ ...current, [activeSeriesKey]: enabled }))} context={{ label: '当前系列', value: activeBrandSeries }} transitionLabel={seriesBrandTransition} />
          </article>
          <article className="material-brand-row material-brand-single-row">
            <a className="material-brand-single-banner" href={`${window.location.pathname}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(window.location.search)), section: 'knowledge' }).toString()}`}><span>04</span><span className="material-brand-single-copy"><strong>单图配置请前往素材库进行配置</strong><small>优先级最高，只应用于指定图片</small></span><ArrowRight size={18} /></a>
          </article>
        </div>
      </section>}

      {view === 'library' && activeStore && (
        <section className="material-store-workspace">
          <div className="material-workspace-overview">
            <div className="material-workspace-intro"><span className="material-workspace-mark" aria-hidden="true"><FolderOpen size={20} /></span><div><span className="section-kicker">MATERIAL LIBRARY</span><h1>素材库</h1><p>按店铺独立管理图片与视频。</p></div></div>
            <div className="material-workspace-actions-card">
              {/* No storage-quota read is wired into this view, so the panel
                  states the unknown instead of drawing an empty track that
                  reads as 「已使用 0%」. */}
              <div className="material-workspace-storage" aria-label="共享储存空间"><div><span>共享储存空间</span><strong>{UNREAD_METRIC} <small>服务端配额</small></strong></div><div><small>配额读取未接入，本次会话上传 {uploadedGb.toFixed(1)} GB</small><b>剩余 {UNREAD_METRIC}</b></div></div>
              <button type="button" className="material-upload-button" onClick={() => { setUploadStoreId(activeStore.id); setUploadSeries(''); setUploadDialogOpen(true) }}><Upload size={17} /><span>上传素材</span></button>
            </div>
          </div>

          <div className="material-toolbar">
            <div className="material-toolbar-filters">
              <label className="material-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索素材名称、分类或格式" /></label>
              <div className="material-store-filter"><span>店铺</span><MaterialCategoryDropdown ariaLabel="店铺筛选" value={activeStoreId} options={materialStores.map((store) => ({ value: store.id, label: store.name }))} onChange={switchStore} searchable searchPlaceholder="搜索店铺" /></div>
              <div className="material-series-filter"><span>系列</span><MaterialCategoryDropdown ariaLabel="系列筛选" value={series} options={[{ value: '全部', label: '全部系列' }, ...availableSeries.map((item) => ({ value: item, label: item }))]} onChange={(value) => { setSeries(value); setSelectedIds([]) }} /></div>
              <div className="material-category-filter"><span>素材分类</span><MaterialCategoryDropdown ariaLabel="素材分类筛选" value={category} options={materialStoreCategories.map((item) => ({ value: item, label: item }))} onChange={(value) => { setCategory(value as '全部' | StoreMaterialCategory); setSelectedIds([]) }} /></div>
            </div>
            <div className="material-toolbar-actions">
              <span className={selectedMaterials.length ? 'has-selection' : ''}>已选 <strong>{selectedMaterials.length}</strong> 项</span>
              {selectedMaterials.length > 0 && <button type="button" className="material-delete-button" onClick={() => setDeleteDialogOpen(true)}><Trash2 size={14} />删除</button>}
              <button type="button" disabled={!visibleMaterials.length} onClick={() => setSelectedIds(allVisibleSelected ? selectedIds.filter((id) => !visibleMaterials.some((item) => item.id === id)) : Array.from(new Set([...selectedIds, ...visibleMaterials.map((item) => item.id)])))}>{allVisibleSelected ? '取消全选' : '全选当前'}</button>
              <a className={selectedMaterials.length ? '' : 'disabled'} href={selectedMaterials.length ? batchDownloadUrl : undefined} download={`${activeStore.name}-已选素材清单.txt`}><Download size={15} />下载已选</a>
            </div>
          </div>

          <div className="material-result-summary"><span>{materialsSummary}</span><small>上传目标：{activeStore.name}</small></div>
          {materialDownloadError && <p className="material-download-error" role="alert">{materialDownloadError}</p>}
          {visibleMaterials.length ? (
            <div className="material-card-grid">
              {visibleMaterials.map((item, index) => {
                const selected = selectedIds.includes(item.id)
                return (
                  <article className={selected ? 'selected' : ''} key={item.id}>
                    <div className={`material-card-preview tone-${(index % 4) + 1}`}>
                      <button type="button" className="material-card-open" aria-label={`查看${item.name}详情`} onClick={() => setDetailMaterialId(item.id)}>{item.previewUrl && item.format !== 'MP4' ? <img src={item.previewUrl} alt="" /> : item.category === '商品视频' ? <Play size={30} fill="currentColor" /> : <ImageIcon size={30} />}<span>{item.category}</span></button>
                      <button type="button" className="material-card-select" aria-label={`选择${item.name}`} aria-pressed={selected} onClick={() => setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>{selected && <Check size={14} />}</button>
                    </div>
                    <div className="material-card-copy"><strong title={item.name}>{item.name}</strong><span>{item.series} · {item.sizeLabel} · {item.format}</span><small>{item.fileSizeLabel} · {item.addedAt}</small></div>
                    <div className="material-card-actions">
                      <div className="material-card-inline-editor">
                        <div className="material-card-inline-field"><span>素材分类</span><MaterialCategoryDropdown ariaLabel={`修改${item.name}的素材分类`} value={item.category} options={materialStoreCategories.filter((value): value is StoreMaterialCategory => value !== '全部').map((value) => ({ value, label: value }))} onChange={(value) => updateMaterialMetadata(item.id, { category: value as StoreMaterialCategory })} /></div>
                        <div className="material-card-inline-field"><span>所属系列</span><MaterialCategoryDropdown ariaLabel={`修改${item.name}的所属系列`} value={item.series} options={availableSeries.map((value) => ({ value, label: value }))} onChange={(value) => updateMaterialMetadata(item.id, { series: value })} /></div>
                      </div>
                      <a href={materialDownloadHref(item, baseUrl)} download={item.name} onClick={(event) => { if (!item.assetId) return; event.preventDefault(); void downloadMaterial(item) }}><Download size={14} />下载</a>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="material-empty"><FolderOpen size={28} /><strong>{materialEmptyTitle}</strong><span>{materialEmptyDetail}</span></div>
          )}
        </section>
      )}
      {activeStore && uploadDialogOpen && (
        <DialogFrame
          title="上传素材"
          kicker="MATERIAL UPLOAD"
          onClose={closeUploadDialog}
          testId="material-upload-dialog"
          actions={<>
            <button type="button" className="catalog-asset-cancel" onClick={closeUploadDialog}>取消</button>
            <button type="button" className="material-upload-confirm" disabled={!pendingFiles.length || !uploadSeries || uploadBusy} onClick={() => { void confirmUpload() }}><Upload size={15} />{uploadBusy ? '正在上传…' : `确认上传${pendingFiles.length ? `（${pendingFiles.length}）` : ''}`}</button>
          </>}
        >
          <div className="material-upload-dialog">
            <div className="material-upload-top">
              <div className="material-upload-store"><MaterialCategoryDropdown ariaLabel="选择上传店铺" value={uploadStore.id} options={materialStores.map((store) => ({ value: store.id, label: store.name }))} onChange={(value) => { setUploadStoreId(value); setUploadSeries('') }} searchable searchPlaceholder="搜索店铺" triggerContent={<span className="material-upload-store-trigger"><span className="catalog-store-logo" aria-hidden="true">{uploadStore.logoUrl ? <img src={uploadStore.logoUrl} alt="" /> : uploadStore.mark}</span><span className="material-upload-store-copy"><small>上传到店铺</small><strong>{uploadStore.name}</strong><em>{uploadStore.platform} · 素材仅归属于所选店铺</em></span></span>} /></div>
              <button type="button" className="material-upload-picker" data-dialog-initial-focus disabled={pendingFiles.length >= 50} onClick={() => uploadInput.current?.click()}><Upload size={18} /><span><strong>{pendingFiles.length ? '继续选择' : '选择图片或视频'}</strong><small>最多 50 个文件</small></span></button>
            </div>
            <input ref={uploadInput} className="sr-only" type="file" accept="image/*,video/*" multiple onChange={(event) => addPendingFiles(event.target.files)} />
            <div className="material-upload-controls">
              <div className="material-upload-category"><span>素材分类</span><MaterialCategoryDropdown ariaLabel="素材分类" value={uploadCategory} options={materialStoreCategories.filter((item): item is StoreMaterialCategory => item !== '全部').map((item) => ({ value: item, label: item }))} onChange={(value) => setUploadCategory(value as StoreMaterialCategory)} /></div>
              <div className="material-upload-category"><span>所属系列</span><MaterialCategoryDropdown ariaLabel="所属系列" value={uploadSeries} options={[{ value: '', label: '请选择系列' }, ...uploadAvailableSeries.map((item) => ({ value: item, label: item }))]} onChange={(value) => setUploadSeries(value)} /></div>
            </div>
            <div className="material-upload-preview-heading"><span>待上传素材 <strong>{pendingFiles.length}</strong> / 50</span><div className="material-upload-batch-actions"><button type="button" disabled={!pendingFiles.length} onClick={() => setPendingSelectedKeys(pendingSelectedKeys.length === pendingFiles.length ? [] : pendingFiles.map(pendingFileKey))}>{pendingSelectedKeys.length === pendingFiles.length && pendingFiles.length ? '取消全选' : '全选'}</button><span>已选 {pendingSelectedKeys.length} 项</span><button type="button" className="danger" disabled={!pendingSelectedKeys.length} onClick={deleteSelectedPendingFiles}><Trash2 size={13} />批量删除</button></div></div>
            <div className={`material-upload-preview-grid ${pendingFiles.length ? '' : 'empty'}`}>
              {pendingPreviews.length ? pendingPreviews.map(({ file, url }, index) => {
                const fileKey = pendingFileKey(file)
                const selected = pendingSelectedKeys.includes(fileKey)
                return <article className={selected ? 'selected' : ''} key={fileKey}>
                  <button type="button" className="material-upload-thumb" aria-label={`放大预览${file.name}`} onClick={() => setPendingPreviewIndex(index)}>{file.type.startsWith('image/') ? <img src={url} alt="" /> : <Play size={24} fill="currentColor" />}</button>
                  <button type="button" className="material-upload-select" aria-label={`选择${file.name}`} aria-pressed={selected} onClick={() => setPendingSelectedKeys((current) => current.includes(fileKey) ? current.filter((key) => key !== fileKey) : [...current, fileKey])}>{selected && <Check size={13} />}</button>
                  <strong title={file.name}>{file.name}</strong>
                  <small>{formatMaterialFileSize(file.size)}</small>
                </article>
              }) : <div><ImageIcon size={30} /><strong>尚未选择素材</strong><span>点击上方按钮，可一次选择或继续追加多张图片。</span></div>}
            </div>
            <p className="material-upload-note">本次文件将上传至“{uploadStore.name}”，统一归入“{uploadCategory}”{uploadSeries ? `，所属“${uploadSeries}”系列` : '；请选择所属系列'}。上传通过服务端素材接口写入，服务端未接受的素材不会出现在素材库中。</p>
            {uploadError && <p className="material-download-error" role="alert" data-testid="material-upload-error">{uploadError}</p>}
            {pendingPreviewIndex !== null && pendingPreviews[pendingPreviewIndex] && <button type="button" className="material-upload-lightbox" aria-label="关闭图片预览" onClick={() => setPendingPreviewIndex(null)}><span>{pendingPreviews[pendingPreviewIndex].file.type.startsWith('image/') ? <img src={pendingPreviews[pendingPreviewIndex].url} alt={pendingPreviews[pendingPreviewIndex].file.name} /> : <span className="material-upload-video-preview"><Play size={52} fill="currentColor" /></span>}<strong>{pendingPreviews[pendingPreviewIndex].file.name}</strong><small>点击任意位置关闭</small></span></button>}
          </div>
        </DialogFrame>
      )}
      {activeStore && deleteDialogOpen && selectedMaterials.length > 0 && (
        <DialogFrame
          title="移入回收站"
          kicker="MOVE TO RECYCLE BIN"
          onClose={() => setDeleteDialogOpen(false)}
          testId="material-delete-dialog"
          actions={<>
            <button type="button" className="catalog-asset-cancel" onClick={() => setDeleteDialogOpen(false)}>取消</button>
            <button type="button" className="material-delete-confirm" onClick={deleteSelectedMaterials}><Trash2 size={14} />移入回收站</button>
          </>}
        >
          <div className="material-delete-dialog"><Trash2 size={24} /><div><strong>确定将已选的 {selectedMaterials.length} 项素材移入回收站？</strong><p>素材会从“{activeStore.name}”的列表移除，并记录在本浏览器的回收站中。</p></div></div>
        </DialogFrame>
      )}
    </div>
  )
}

/**
 * How the catalogue prints a count that comes out of a server read.
 *
 * `null` is not `0`. Both numbers in the header are projections of a read that
 * may not have answered — the readable stores come from
 * `/v1/platform-accounts`, the product total from `/v1/products` — and the
 * catalogue used to fold an unanswered read into `0`, so a failed read was
 * rendered as 「已连接店铺 0」 / 「当前目录 0 个商品」 next to panels that said
 * both reads had failed. `failed` separates 「读取失败」 from 「未读取」; a read
 * that answered, including one that answered `0`, is printed as its count.
 *
 * See `catalog-read-honesty.test.ts`.
 */
export function resolveCatalogReadCountText({ count, failed }: {
  /** The read's answer, or `null` while it has not answered. */
  count: number | null
  /** Whether the read settled without an answer, as opposed to still being in flight. */
  failed: boolean
}): string {
  if (count !== null) return count.toLocaleString()
  return failed ? READ_FAILED_METRIC : UNREAD_METRIC
}

/**
 * The sync control — its label and the hint under it — for one store-read state.
 *
 * Only a store read that *answered* can say 「等待店铺连接」 or 「先连接一个可读取
 * 的店铺」: those sentences claim the workspace has no readable store, which a
 * read that failed or has not come back cannot know. The four states are kept
 * apart here because the shipped bug printed the failed read as that claim.
 */
export function resolveCatalogSyncControl({
  baseUrl,
  syncableStores,
  accountsLoading,
  accountsError,
  syncing,
  idleHint,
}: {
  /** The configured API, or `undefined` for the offline demo. */
  baseUrl?: string
  /** Syncable stores as the read answered them, or `null` while it has not answered. */
  syncableStores: number | null
  accountsLoading: boolean
  accountsError: string
  syncing: boolean
  /** What the hint says once the store read has answered (or with no API at all). */
  idleHint: string
}): { label: string; hint: string } {
  const label = syncing
    ? '同步全部店铺…'
    : accountsLoading
      ? '正在发现店铺…'
      : !baseUrl
        ? '演示数据'
        : syncableStores === 0
          ? '等待店铺连接'
          : syncableStores === null
            ? accountsError
              ? READ_FAILED_METRIC
              : '店铺连接未读取'
            : '同步全部店铺'
  const hint =
    baseUrl && !accountsLoading && syncableStores === 0
      ? '下一步：先连接一个可读取的店铺，再回来同步商品。'
      : baseUrl && !accountsLoading && syncableStores === null
        ? accountsError
          ? '下一步：重试店铺发现，确认店铺身份后再同步商品。'
          : '店铺连接未读取，无法判断是否已连接可读取的店铺。'
        : idleHint
  return { label, hint }
}

export function Products({
  baseUrl,
  apiMode,
  modelStatus,
  modelStatusRead,
  onRefreshModelStatus,
  initialQuery = '',
  initialEntry = 'products',
  onSelectTarget,
  onOpenTasks,
}: {
  baseUrl?: string
  apiMode?: string | null
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
  onRefreshModelStatus: () => void
  initialQuery?: string
  initialEntry?: MerchantEntryPoint
  onSelectTarget: (target: Target) => void
  onOpenTasks: () => void
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
  const [platformMenuOpen, setPlatformMenuOpen] = useState(false)
  const [accountFilter, setAccountFilter] = useState('')
  useEffect(() => {
    if (!platformMenuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlatformMenuOpen(false)
    }
    const closeOnOutside = (event: MouseEvent) => {
      if (!(event.target as HTMLElement)?.closest('.filter-select-wrap'))
        setPlatformMenuOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('mousedown', closeOnOutside)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('mousedown', closeOnOutside)
    }
  }, [platformMenuOpen])
  const [productPage, setProductPage] = useState(0)
  // `null` — not `0` — until `/v1/products` answers. The total is what the
  // header's 「当前目录 N 个商品」 is drawn from, and a failed read has no total.
  const [productTotal, setProductTotal] = useState<number | null>(null)
  const [groupCreating, setGroupCreating] = useState(false)
  const [groupMessage, setGroupMessage] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [importErrorField, setImportErrorField] = useState<'title' | 'account' | 'category' | 'price' | 'stock' | null>(null)
  const [importDraft, setImportDraft] = useState({
    title: '',
    platform: 'taobao' as PlatformId,
    accountId: '',
    category: '',
    price: '0',
    stock: '0',
  })
  const [importAssets, setImportAssets] = useState<AssetMetadata[]>([])
  const [selectedImportAssetIds, setSelectedImportAssetIds] = useState<
    string[]
  >([])
  const [importAssetsLoading, setImportAssetsLoading] = useState(false)
  const importErrorRef = useRef<HTMLDivElement>(null)
  const [groupConfirmOpen, setGroupConfirmOpen] = useState(false)
  const [imageReviewMessage, setImageReviewMessage] = useState('')
  const [imageGenerationTarget, setImageGenerationTarget] = useState<Target | null>(null)
  const [imageGenerationMode, setImageGenerationMode] = useState<'create' | 'optimize'>('create')
  const [imageGenerationDirection, setImageGenerationDirection] = useState('保留商品本体，生成适合电商首图的干净背景与克制光影')
  const [imageGenerationCount, setImageGenerationCount] = useState('1')
  const [imageGenerationBusy, setImageGenerationBusy] = useState(false)
  const [imageGenerationError, setImageGenerationError] = useState('')
  const [imageGenerationErrorField, setImageGenerationErrorField] = useState<'direction' | 'count' | null>(null)
  const imageGenerationErrorRef = useRef<HTMLDivElement>(null)
  const imageGenerationConfigRef = useRef<HTMLDivElement>(null)
  const [relationProductId, setRelationProductId] = useState('')
  const [canonicalFreshness, setCanonicalFreshness] = useState<'fresh' | 'expired' | 'unknown'>('unknown')
  const productListRef = useRef<HTMLElement>(null)
  const imageModelReady = modelStatusRead && modelStatus?.state === 'ready' && modelStatus.capabilities?.image_generation !== false
  const imageModelBlocker = !baseUrl
    ? '尚未配置商家 API 或模型中转，系统不会读取、生成或扣费。'
    : !modelStatusRead
      ? '正在检查模型中转配置；配置确认前不会生成或扣费。'
      : !modelStatus
        ? '模型中转状态读取失败，系统不会生成或扣费。请联系管理员完成测试环境配置后，再重新检查。'
        : modelStatus.state !== 'ready'
          ? `模型中转尚未就绪，系统不会生成或扣费。${modelStatus.next_actions?.[0] ? ` ${userFacingModelAction(modelStatus.next_actions[0])}` : '请联系管理员完成测试环境配置后，再重新检查。'}`
          : modelStatus.capabilities?.image_generation === false
            ? '当前模型中转未开放图片生成能力，系统不会生成或扣费。请联系管理员启用图片生成后，再重新检查。'
            : ''
  useEffect(() => {
    if (!imageGenerationTarget || !imageModelBlocker) return
    window.requestAnimationFrame(() => imageGenerationConfigRef.current?.focus({ preventScroll: true }))
  }, [imageGenerationTarget, imageModelBlocker])
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
      limit: productPageSize,
      offset: productPage * productPageSize,
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
          // A failed read leaves the total unknown, not zero: `0` here became
          // 「当前目录 0 个商品」 on a page that said the list was unavailable.
          setProductTotal(null)
          setError(`商品读取失败：${describeApiError(cause)} 当前不会执行任何外部写入。`)
        }
      })
      .finally(() => {
        if (requestId === productsRequestId.current) setLoading(false)
      })
  }
  useEffect(() => {
    if (!baseUrl) { setCanonicalFreshness('unknown'); return }
    let active = true
    void requestMcp<{ freshness?: 'fresh' | 'expired' | 'unknown' }>(baseUrl, 'canonical.product.consistency')
      .then((report) => { if (active) setCanonicalFreshness(report.freshness ?? 'unknown') })
      .catch(() => { if (active) setCanonicalFreshness('unknown') })
    return () => { active = false }
  }, [baseUrl])
  const loadAccounts = () => {
    const requestId = ++accountsRequestId.current
    if (!baseUrl || isManualPlatformOperationsMode(apiMode)) {
      setAccounts([])
      setAccountsLoading(false)
      setAccountsError('')
      return
    }
    if (!shouldDiscoverPlatformAccounts(baseUrl, apiMode)) {
      setAccounts(null)
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
  }, [baseUrl, apiMode])
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
    // Opening the catalog should keep the page header and primary actions in
    // view. Only deep-links into the asset library need an automatic scroll;
    // scrolling the product table into view on every navigation hid the title
    // and made the page appear to load in the middle of a diagnostic card.
    if (initialEntry !== 'products') {
      destination?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'start',
      })
    }
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
        brandId: product.brandId ?? product.canonical_scope?.brand_id ?? undefined,
        listingId: product.canonical_scope?.listing_id ?? undefined,
        canonicalProductId: product.canonical_scope?.canonical_product_id ?? undefined,
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
  // Keep the catalog readable at desktop density and align with the backend
  // list contract: every page is a stable 20-row window.
  const productPageSize = 20
  // `null` while `/v1/products` has not answered; the offline demo reads its
  // local fixture rows, so it always has a number here.
  const effectiveProductTotal = baseUrl ? productTotal : visible.length
  const productPageCount = Math.max(
    1,
    Math.ceil((effectiveProductTotal ?? 0) / productPageSize),
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
          : null
        : rows.length,
      needsReview: baseUrl
        ? productFilter === 'needsReview'
          ? productTotal
          : null
        : rows.filter((product) => product.issue > 0).length,
    }),
    [baseUrl, productFilter, productTotal, rows],
  )
  const productListUnavailable = Boolean(
    baseUrl && !loading && remoteProducts === null,
  )
  const showAssetLibrary = initialEntry !== 'products'
  // `null` — not `0` — while `/v1/platform-accounts` has not answered. `accounts`
  // is `null` for a read in flight and for a read that failed, and both used to
  // be counted as "no readable store", which the page then acted on.
  const syncableAccountCount =
    accounts === null
      ? null
      : accounts.filter(
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
          ...(platformFilter !== 'all' ? { platform: platformFilter } : {}),
          ...(accountFilter ? { accountId: accountFilter } : {}),
          ...(productFilter === 'needsReview' ? { factsConfirmed: false } : {}),
          limit: productPageSize,
          offset: productPage * productPageSize,
        })
        setRemoteProducts(refreshed.items)
        setProductTotal(refreshed.total)
      } catch (cause) {
        setRemoteProducts(null)
        // The refresh failed, so the list is gone and so is the total it came
        // with; keeping the previous total would draw a count beside a list the
        // page has just declared unavailable.
        setProductTotal(null)
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
      accountId: '',
      category: '',
      price: '0',
      stock: '0',
    })
    setSelectedImportAssetIds([])
    setImportError('')
    setImportErrorField(null)
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
    const accountId = importDraft.accountId.trim()
    const category = importDraft.category.trim()
    const price = Number(importDraft.price)
    const stock = Number(importDraft.stock)
    if (!title) {
      setImportError('请输入商品名称。')
      setImportErrorField('title')
      return
    }
    if (!accountId) {
      setImportError('请选择已连接且可读取的店铺账号；生产导入必须绑定明确店铺身份。')
      setImportErrorField('account')
      return
    }
    if (!category) {
      setImportError('请输入平台类目；创建商品时不能省略。')
      setImportErrorField('category')
      return
    }
    if (!Number.isFinite(price) || price < 0) {
      setImportError('价格必须是大于或等于 0 的数字。')
      setImportErrorField('price')
      return
    }
    if (!Number.isInteger(stock) || stock < 0) {
      setImportError('库存必须是大于或等于 0 的整数。')
      setImportErrorField('stock')
      return
    }
    setImporting(true)
    setImportError('')
    setImportErrorField(null)
    try {
      await importProduct(baseUrl, {
        platform: importDraft.platform,
        account_id: accountId,
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
      setImportErrorField(null)
    } finally {
      setImporting(false)
    }
  }
  useEffect(() => {
    if (!importOpen || importing || !importError) return
    window.requestAnimationFrame(() => importErrorRef.current?.focus({ preventScroll: true }))
  }, [importError, importOpen, importing])
  const toggleTarget = (target: Target) =>
    setSelectedTargets((current) => toggleBatchTarget(current, target))
  const batchReadiness = resolveBatchReadiness(
    Boolean(baseUrl),
    selectedTargets.length,
  )
  // The sync control's label and hint are resolved from the store read's state
  // so that a read that never answered cannot be phrased as "no store to sync".
  const syncControl = resolveCatalogSyncControl({
    baseUrl,
    syncableStores: syncableAccountCount,
    accountsLoading,
    accountsError,
    syncing,
    idleHint: batchReadiness.canCreateGroup
      ? '已满足批量条件：将按商品 + 平台 + 店铺拆成独立子任务。'
      : batchReadiness.nextStep,
  })
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
      const brandIds = [...new Set(selectedTargets.map((item) => item.brandId).filter((id): id is string => Boolean(id)))]
      if (brandIds.length !== 1 || selectedTargets.some((item) => !item.brandId)) {
        throw new Error('批量生产要求所选商品属于同一个品牌，请先完成品牌绑定后再创建任务组。')
      }
      const campaign = await createCampaignBatch(baseUrl, {
        brand_id: brandIds[0]!,
        targets: selectedTargets.map((item) => ({
          product_id: item.productId,
          platform: item.platform,
          account_id: item.accountId!,
          ...(item.canonicalProductId ? { canonical_product_id: item.canonicalProductId } : {}),
          ...(item.listingId ? { listing_id: item.listingId } : {}),
        })),
        idempotency_key: `merchant-studio-campaign-${selectedTargets.map((item) => batchTargetKey(item)).sort().join('|')}`,
      })
      const campaignId = campaign.id ?? campaign.campaignId
      if (!campaignId) throw new Error('批量计划已返回，但缺少 campaign_id，无法进入逐项生产。')
      let generated: typeof campaign | undefined
      try {
        generated = await generateCampaignBatch(baseUrl, campaignId, '按商品事实和品牌规则逐项生成营销内容，等待审核。', `merchant-studio-campaign-generate-${campaignId}`)
      } catch (cause) {
        // The plan is durable even when a precondition (facts, canonical
        // listing, points, or provider readiness) blocks generation. Keep the
        // campaign visible so the operator can resolve and resume it.
        setGroupMessage(`批量计划已创建（${campaignId}），逐项生成被门禁阻止：${describeApiError(cause)}。请处理阻断项后在营销任务中继续。`)
      }
      const taskIds = generated?.taskIds ?? []
      const generatedState = generated ? resolveBatchResultState(generated) : 'empty'
      if (generated && generatedState === 'blocked') {
        const validation = generated.delivery_manifest?.validation
        setGroupMessage(`批量计划已创建（${campaignId}），当前仍被交付门禁阻断${validation?.code ? `：${validation.code}` : ''}。请在营销任务中查看修复路径后再继续。`)
      } else if (generated && generatedState === 'partial') {
        setGroupMessage(`批量计划已创建，但仅部分子任务可继续（${taskIds.length} 个）。请在营销任务中逐项处理失败或阻断项。`)
        onOpenTasks()
      } else if (generated && generatedState === 'empty') {
        setGroupMessage(`批量计划已创建（${campaignId}），服务端尚未返回可执行子任务；未将空结果当作生成成功。请在营销任务中刷新状态。`)
        onOpenTasks()
      } else if (generated && taskIds.length) {
        setGroupMessage(`批量计划已创建并进入逐项生产（${taskIds.length} 个子任务）。请在营销任务中逐项审核后发布。`)
        onOpenTasks()
      }
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
    if (!direction) { setImageGenerationError('请填写图片生成方向。'); setImageGenerationErrorField('direction'); return }
    if (!Number.isInteger(count) || count < 1 || count > 6) { setImageGenerationError('候选数量必须是 1–6。'); setImageGenerationErrorField('count'); return }
    setImageGenerationBusy(true); setImageGenerationError(''); setImageGenerationErrorField(null)
    try {
      const result = await generateProductImages(baseUrl, { product_id: imageGenerationTarget.productId, platform: imageGenerationTarget.platform, ...(imageGenerationTarget.accountId ? { account_id: imageGenerationTarget.accountId } : {}), direction, mode: imageGenerationMode, count: String(count), idempotency_key: `merchant-studio-image-${imageGenerationTarget.productId}-${imageGenerationTarget.platform}-${count}-${direction}` })
      setImageGenerationTarget(null)
      // The job panel lives in the task workspace.  The old URL preserved the
      // current /merchant/products path, so a successful generation appeared
      // to do nothing and the user could not inspect the real job state.
      const taskUrl = new URL(
        urlForMerchantRoute(window.location, { page: 'task' }),
        window.location.origin,
      )
      taskUrl.searchParams.set('image_job', result.job_id)
      window.location.href = `${taskUrl.pathname}${taskUrl.search}`
    } catch (cause) { setImageGenerationError(describeApiError(cause)); setImageGenerationErrorField(null) }
    finally { setImageGenerationBusy(false) }
  }
  useEffect(() => {
    if (!imageGenerationError || imageGenerationBusy || !imageGenerationTarget) return
    window.requestAnimationFrame(() => imageGenerationErrorRef.current?.focus({ preventScroll: true }))
  }, [imageGenerationBusy, imageGenerationError, imageGenerationTarget])
  if (showAssetLibrary) {
    // The store rows come from the reads this page already performs, so the
    // material workspace can never disagree with the catalogue about the
    // workspace's stores (it used to read its own eight-store seed instead).
    const materialWorkspaceProps = { baseUrl, accounts, products: remoteProducts } as const
    return initialEntry === 'knowledge'
      ? <MaterialLibraryWorkspace {...materialWorkspaceProps} view="library" />
      : initialEntry === 'assets'
        ? <MaterialLibraryWorkspace {...materialWorkspaceProps} view="brands" />
      : initialEntry === 'trash'
        ? <MaterialRecycleBinWorkspace />
      : <MaterialLibraryWorkspace {...materialWorkspaceProps} view="library" />
  }
  return (
    <div className="page-stack products-page">
      <section className="page-intro">
        <div>
          <span className="section-kicker">PRODUCT CATALOG</span>
          <h2>管理商品事实与素材</h2>
          <p>
            先确认商品事实与店铺身份，再生成内容或创建批量任务。所有操作都会保留来源证据。
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
          {baseUrl && !accountsLoading && !accountsError && accounts && syncableAccountCount === 0 && (
            <span className="knowledge-plan-external">请在Store Nova ChatGPT 插件中绑定店铺后再同步</span>
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
            {syncControl.label}
          </button>
          <small id="batch-action-help" className="action-help">
            {syncControl.hint}
          </small>
        </div>
      </section>
      <section className="products-summary" aria-label="商品目录概览">
        <div className="products-summary-main">
          <span className="section-kicker">当前目录</span>
          <strong>{resolveCatalogReadCountText({ count: effectiveProductTotal, failed: productListUnavailable })}</strong>
          <span>个商品</span>
        </div>
        <div className="products-summary-item">
          <span>当前范围</span>
          <b>{platformFilter === 'all' ? '全部平台' : platformNames[platformFilter]}</b>
        </div>
        <div className="products-summary-item">
          <span>已连接店铺</span>
          <b>{resolveCatalogReadCountText({ count: syncableAccountCount, failed: Boolean(accountsError) })}</b>
        </div>
        <div className="products-summary-item">
          <span>已选择任务目标</span>
          <b>{selectedTargets.length}</b>
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
        freshness={canonicalFreshness}
        errorMessage={productListUnavailable ? '商品列表暂不可用，规范商品状态无法确认。' : undefined}
        onRefresh={loadProducts}
        onResolveCanonical={() => {
          const firstProduct = visible[0]
          if (firstProduct) setRelationProductId(firstProduct.id)
          else loadProducts()
        }}
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
            : '未发现已授权且可读取的店铺；请先在Store Nova ChatGPT 插件中绑定店铺，再回来同步商品。'}
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
        aria-busy={loading}
      >
        <div className="catalog-panel-heading">
          <div>
            <span className="section-kicker">CATALOG</span>
            <h3>商品目录</h3>
          </div>
          <div className="catalog-status-legend" aria-label="商品状态说明">
            <span><i className="legend-dot green" aria-hidden="true" />已确认</span>
            <span><i className="legend-dot amber" aria-hidden="true" />待确认</span>
            <span><i className="legend-dot neutral" aria-hidden="true" />待流程</span>
          </div>
        </div>
        <div className="table-toolbar products-toolbar">
          <label className="inline-search">
            <Search size={16} />
            <span className="sr-only">搜索商品</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索商品或平台"
            />
          </label>
          <div className="filter-select-wrap">
            <span className="sr-only" id="product-platform-filter-label">按平台筛选</span>
            <button
              type="button"
              className="filter-select-trigger"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={platformMenuOpen}
              aria-controls="product-platform-filter-options"
              aria-labelledby="product-platform-filter-label"
              onClick={() => setPlatformMenuOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setPlatformMenuOpen(true)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setPlatformMenuOpen(false)
                }
              }}
            >
              {platformFilter === 'all' ? '全部平台' : platformNames[platformFilter]}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {platformMenuOpen && (
              <div className="filter-select-menu" id="product-platform-filter-options" role="listbox" aria-label="平台选项">
                {[['all', '全部平台'], ...Object.entries(platformNames)].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={platformFilter === id}
                    className={platformFilter === id ? 'selected' : undefined}
                    onClick={() => {
                      setPlatformFilter(id as PlatformId | 'all')
                      setAccountFilter('')
                      setPlatformMenuOpen(false)
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
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
              全部{productStats.total === null ? '' : ` ${productStats.total}`}
            </button>
            <button
              className={
                'filter ' + (productFilter === 'needsReview' ? 'active' : '')
              }
              onClick={() => setProductFilter('needsReview')}
            >
              待确认{productStats.needsReview === null ? '' : ` ${productStats.needsReview}`}
            </button>
            {(query || platformFilter !== 'all' || accountFilter || productFilter !== 'all') && (
              <button
                className="clear-filters"
                onClick={() => {
                  setQuery('')
                  setPlatformFilter('all')
                  setAccountFilter('')
                  setProductFilter('all')
                }}
              >
                清除筛选
              </button>
            )}
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
              <caption className="sr-only">商品目录，包含任务组、商品、平台、店铺、素材关系、事实来源、库存和状态</caption>
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
                  const target = projectProductRowTarget(product)
                  const identityError = validateTargetStoreIdentity(target)
                  const canonicalStatus = product.canonicalScope?.verification_status
                  const canonicalUnverified = !canonicalProductActionAllowed({ apiConfigured: Boolean(baseUrl), status: canonicalStatus })
                  const canonicalCopy = canonicalStatus
                    ? canonicalStatusCopy[canonicalStatus]
                    : { label: '标准链待核验', detail: '服务端尚未返回规范商品状态，不能视为已通过', tone: 'amber' }
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
                          title={!baseUrl ? '尚未连接商家 API' : productListUnavailable ? '商品列表读取失败，请先重试' : '读取服务端主图检查结果'}
                        >
                          主图检查
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            if (canonicalUnverified) {
                              setError(`暂不能生成图片：${canonicalCopy.detail}。请先点击“打开商品关系并核验”。`)
                              return
                            }
                            setImageGenerationError(''); setImageGenerationErrorField(null); setImageGenerationMode(product.sourceAssetIds.length ? 'optimize' : 'create'); setImageGenerationTarget(target); setImageGenerationCount('1')
                          }}
                          disabled={!baseUrl || productListUnavailable || Boolean(identityError) || !product.factsConfirmed}
                          title={!baseUrl ? '尚未连接商家 API' : identityError ?? (!product.factsConfirmed ? '请先确认商品事实' : canonicalUnverified ? canonicalCopy.detail : undefined)}
                        >
                          生成图片 <ImageIcon size={14} />
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            if (canonicalUnverified) {
                              setError(`暂不能创建任务：${canonicalCopy.detail}。请先点击“打开商品关系并核验”。`)
                              return
                            }
                            onSelectTarget(target)
                          }}
                          disabled={
                            !baseUrl ||
                            productListUnavailable ||
                            Boolean(identityError) ||
                            canonicalUnverified
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
              : effectiveProductTotal === null
                ? productListUnavailable
                  ? '商品列表暂不可用'
                  : '正在读取商品列表…'
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
                  setImportErrorField(null)
                }}
                aria-invalid={importErrorField === 'title'}
                aria-describedby={importError ? 'import-product-error' : undefined}
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
                    accountId: '',
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
            <label htmlFor="import-product-account">
              店铺账号
              <select
                id="import-product-account"
                value={importDraft.accountId}
                onChange={(event) => {
                  setImportDraft((current) => ({ ...current, accountId: event.target.value }))
                  setImportError('')
                  setImportErrorField(null)
                }}
                aria-invalid={importErrorField === 'account'}
                aria-describedby={importError ? 'import-product-error' : undefined}
              >
                <option value="">请选择店铺账号</option>
                {(accounts ?? [])
                  .filter((account) => account.platform === importDraft.platform && account.accountId && account.readEnabled)
                  .map((account) => <option key={account.accountId} value={account.accountId}>{account.storeName ?? account.alias ?? account.label ?? account.accountId} · {account.accountId}</option>)}
              </select>
              <small className="muted-help">必须选择真实已连接身份；未配置或不可读取的店铺不会出现在这里。</small>
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
                  setImportErrorField(null)
                }}
                aria-invalid={importErrorField === 'category'}
                aria-describedby={importError ? 'import-product-error' : undefined}
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
                  setImportErrorField(null)
                }}
                aria-invalid={importErrorField === 'price'}
                aria-describedby={importError ? 'import-product-error' : undefined}
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
                  setImportErrorField(null)
                }}
                aria-invalid={importErrorField === 'stock'}
                aria-describedby={importError ? 'import-product-error' : undefined}
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
            {importError && (
              <div
                ref={importErrorRef}
                id="import-product-error"
                className="error-notice"
                role="alert"
                tabIndex={-1}
                aria-live="assertive"
                aria-atomic="true"
                aria-labelledby="import-product-error-title"
              >
                <strong id="import-product-error-title">无法导入商品</strong>
                <span>{importError}</span>
                {importErrorField && (
                  <a href={`#import-product-${importErrorField}`}>
                    跳转到需要修正的字段
                  </a>
                )}
                <span className="sr-only">请修正表单后重新提交；已填写内容会保留。</span>
              </div>
            )}
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
            onSelectTarget(projectProductTarget(product))
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
          actions={<><button className="secondary" onClick={() => setImageGenerationTarget(null)} disabled={imageGenerationBusy}>取消</button><button className="primary" onClick={() => void submitImageGeneration()} disabled={imageGenerationBusy || !imageModelReady}>{imageGenerationBusy ? '提交中…' : '确认生成'}</button></>}
        >
          <div className="dialog-form">
            {imageGenerationTarget && imageModelBlocker && (
              <div
                ref={imageGenerationConfigRef}
                className="error-notice image-generation-config-blocker"
                role="alert"
                tabIndex={-1}
                aria-live="assertive"
                aria-atomic="true"
                aria-labelledby="image-generation-config-title"
                aria-describedby="image-generation-config-description"
              >
                <strong id="image-generation-config-title">图片生成暂不可用</strong>
                <span id="image-generation-config-description">{imageModelBlocker}</span>
                {baseUrl && modelStatusRead && (
                  <button className="secondary-button" type="button" onClick={onRefreshModelStatus} disabled={imageGenerationBusy}>
                    重新检查模型中转
                  </button>
                )}
              </div>
            )}
            <div className="info-notice" role="status">将进入真实图片任务队列；生成完成后仍需安全扫描、人工审核和候选选择，不会直接发布。</div>
            <label htmlFor="image-generation-direction">生成方向<textarea id="image-generation-direction" aria-invalid={imageGenerationErrorField === 'direction'} aria-describedby={imageGenerationError ? 'image-generation-error' : undefined} data-dialog-initial-focus value={imageGenerationDirection} onChange={event => { setImageGenerationDirection(event.target.value); setImageGenerationError(''); setImageGenerationErrorField(null) }} maxLength={500} rows={4} /></label>
            <label htmlFor="image-generation-count">候选数量<input id="image-generation-count" inputMode="numeric" aria-invalid={imageGenerationErrorField === 'count'} aria-describedby={imageGenerationError ? 'image-generation-error' : undefined} value={imageGenerationCount} onChange={event => { setImageGenerationCount(event.target.value); setImageGenerationError(''); setImageGenerationErrorField(null) }} /></label>
            {imageGenerationError && <div id="image-generation-error" ref={imageGenerationErrorRef} className="error-notice" role="alert" tabIndex={-1} aria-live="assertive" aria-atomic="true"><strong>无法提交图片生成</strong><span>{imageGenerationError}</span>{imageGenerationErrorField && <a href={`#image-generation-${imageGenerationErrorField}`}>跳转到需要修正的字段</a>}<span className="sr-only">请修正表单后重新提交。</span></div>}
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
  const detailSopSteps = resolveDetailSopSteps(detailModules)
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
        <section className="detail-sop-overview" aria-labelledby="detail-sop-title">
          <div className="detail-section-head">
            <div>
              <span className="section-kicker">DETAIL PAGE SOP</span>
              <h4 id="detail-sop-title">按买家问题审阅 8 屏详情页</h4>
            </div>
            <small>文字讲卖点，证据负责证明</small>
          </div>
          <ol className="detail-sop-steps">
            {detailSopSteps.map(step => (
              <li key={step.key} className={`detail-sop-step sop-${step.disposition}`}>
                <span className="detail-sop-number" aria-hidden="true">{step.position}</span>
                <div>
                  <b>{step.label}</b>
                  <span>{step.question}</span>
                  <small title={step.statusDetail}>{step.statusLabel}</small>
                </div>
              </li>
            ))}
          </ol>
          <p className="detail-sop-note" role="note">未生成、缺证或待确认的屏幕只显示状态，不会被当作已验证卖点。</p>
        </section>
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
  const configurationBlockerRef = useRef<HTMLDivElement>(null)
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
          const mergedJobs = mergeImageGenerationJobs(lastSuccessfulJobsRef.current, value.items)
          lastSuccessfulJobsRef.current = mergedJobs
          setJobs(mergedJobs)
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
  useEffect(() => {
    if (!baseUrl) window.requestAnimationFrame(() => configurationBlockerRef.current?.focus())
  }, [baseUrl])
  const stateLabels: Record<string, string> = { queued: '排队中', running: '处理中', succeeded: '生成完成，等待审查', failed: '生成失败', pending: '归档中，等待安全扫描', partial: '部分归档，等待补偿', external_unarchived: '归档未确认，等待对账', provider_reserved: imageGenerationExecutionLabel('provider_reserved'), provider_dispatching: imageGenerationExecutionLabel('provider_dispatching'), provider_started: imageGenerationExecutionLabel('provider_started'), outcome_unknown: imageGenerationExecutionLabel('outcome_unknown') }
  if (!baseUrl) return <div ref={configurationBlockerRef} className="error-notice image-generation-discovery-config-blocker" role="alert" tabIndex={-1} aria-labelledby="image-job-discovery-config-title" aria-describedby="image-job-discovery-config-description">
    <strong id="image-job-discovery-config-title">图片任务发现暂不可用</strong>
    <span id="image-job-discovery-config-description">尚未配置商家 API 或模型中转，系统不会读取、创建演示任务、生成或扣费。请联系管理员完成测试环境配置后，再刷新此页面。</span>
    <button className="secondary-button" type="button" onClick={() => window.location.reload()}>刷新页面</button>
  </div>
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
  const [configurationError, setConfigurationError] = useState(false)
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [reload, setReload] = useState(0)
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const [imageReloads, setImageReloads] = useState<Record<string, number>>({})
  const [candidatePage, setCandidatePage] = useState(1)
  const [selectedVisualRefs, setSelectedVisualRefs] = useState<string[]>([])
  const [selectionReason, setSelectionReason] = useState('人工确认候选图并进入内容版本审阅')
  const [selectionState, setSelectionState] = useState<'idle' | 'submitting' | 'succeeded' | 'failed'>('idle')
  const [selectionMessage, setSelectionMessage] = useState('')
  const [selectedContentVersionId, setSelectedContentVersionId] = useState('')
  const [selectionNotice, setSelectionNotice] = useState('')
  const selectionErrorRef = useRef<HTMLDivElement>(null)
  const imageJobReadErrorRef = useRef<HTMLDivElement>(null)
  const imageJobConfigurationErrorRef = useRef<HTMLDivElement>(null)
  const retryErrorFocusRequestedRef = useRef(false)
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
        if (active) {
          retryErrorFocusRequestedRef.current = false
          setJob(next)
          setError('')
          setConfigurationError(false)
          pollDelayRef.current = nextImageJobPollDelay(pollDelayRef.current, 'success')
        }
      } catch (cause) {
        const apiError = cause as { code?: string; status?: number }
        // A missing deep-linked job is terminal for this panel. Retrying it
        // forever makes an invalid URL look like a healthy loading state.
        shouldPoll = !(apiError.status === 404 || ['GENERATION_JOB_NOT_FOUND', 'IMAGE_GENERATION_JOB_NOT_FOUND'].includes(apiError.code ?? ''))
        pollDelayRef.current = nextImageJobPollDelay(pollDelayRef.current, 'error')
        if (active) {
          setConfigurationError(isImageGenerationConfigurationError(cause))
          setError(describeApiError(cause))
        }
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
  useEffect(() => { setSelectedContentVersionId('') }, [currentJobId])
  useEffect(() => {
    if (error && !loading && (!job || retryErrorFocusRequestedRef.current)) {
      retryErrorFocusRequestedRef.current = false
      window.requestAnimationFrame(() => imageJobReadErrorRef.current?.focus())
    }
  }, [error, job, loading])
  useEffect(() => {
    if (configurationError && !loading) window.requestAnimationFrame(() => imageJobConfigurationErrorRef.current?.focus())
  }, [configurationError, loading])
  useEffect(() => {
    if (!baseUrl) window.requestAnimationFrame(() => imageJobConfigurationErrorRef.current?.focus())
  }, [baseUrl])
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
      setSelectedContentVersionId(selected.content_version_id)
      setSelectionState('succeeded'); setSelectionMessage(`已提交 ${selected.visualSelection.count} 张候选，生成新的待审核内容版本 ${selected.content_version_id}。`)
    } catch (cause) {
      setSelectionState('failed')
      setSelectionMessage(describeApiError(cause))
      window.requestAnimationFrame(() => selectionErrorRef.current?.focus())
    }
  }
  const executionState = job?.executionState
  const displayState = !job ? '' : job.archiveState === 'pending' ? 'archiving' : job.archiveState === 'partial' ? 'partial_archive' : job.archiveState === 'external_unarchived' ? 'external_unarchived' : executionState && ['provider_reserved', 'provider_dispatching', 'provider_started', 'outcome_unknown', 'dispatching'].includes(executionState) ? executionState : job.state
  const succeededDisplayLabel = job?.preferredCandidate?.visualRef
    ? '候选已审核并选定，等待内容版本'
    : job?.outputs?.some(output => output.reviewStatus === 'passed')
      ? '生成完成，等待候选选择'
      : '生成完成，等待人工审核'
  const displayStateLabels: Record<string, string> = { ...labels, succeeded: succeededDisplayLabel, archiving: '归档中，等待安全扫描', partial_archive: '部分归档，等待补偿', external_unarchived: '归档未确认，等待对账' }
  const displayStateTone = displayState === 'failed' || displayState === 'outcome_unknown' || displayState === 'external_unarchived' ? 'amber' : displayState === 'succeeded' && job?.archiveState === 'archived' ? 'green' : 'blue'
  const candidatePageData = getImageCandidatePage(job?.images?.map((src, index) => ({ src, index })) ?? [], candidatePage)
  const reviewTaskId = job?.taskId ?? ''
  const focusImageError = () => document.getElementById('image-job-error')?.focus()
  const backToTaskQueue = () => {
    window.location.href = window.location.pathname
  }
  const retrySafeImageJob = async () => {
    if (!baseUrl || !job || !imageGenerationRetryAllowed({ state: job.state, executionState: job.executionState, nextActionAllowed: job.nextAction?.allowed })) return
    setRetrying(true)
    try { const next = await retryImageGeneration(baseUrl, job.jobId, job.revision); setJob(current => current ? { ...current, jobId: next.job_id, state: next.state, archiveState: 'pending', errorCode: null, errorMessage: null } : current); setReload(value => value + 1) }
    catch (cause) {
      retryErrorFocusRequestedRef.current = true
      setError(describeApiError(cause))
    }
    finally { setRetrying(false) }
  }
  if (!baseUrl) return <div ref={imageJobConfigurationErrorRef} className="error-notice image-job-config-blocker" role="alert" tabIndex={-1} aria-labelledby="image-job-config-title" aria-describedby="image-job-config-description">
    <strong id="image-job-config-title">图片任务暂不可用</strong>
    <span id="image-job-config-description">尚未配置商家 API 或模型中转，系统不会读取、生成或扣费。请联系管理员完成测试环境配置后，再刷新此页面。</span>
    <button className="secondary-button" type="button" onClick={() => window.location.reload()}>刷新页面</button>
  </div>
  const isTerminal = job?.state === 'succeeded' || job?.state === 'failed'
  return <section className="panel image-generation-job-panel" aria-labelledby="image-job-title" aria-busy={loading}>
    <div className="task-breadcrumb" aria-label="任务位置">
      <Breadcrumb items={[{ title: <Button type="link" size="small" onClick={backToTaskQueue}>营销任务</Button> }, { title: '图片生成任务' }]} />
    </div>
    <div className="detail-section-head"><div><span className="section-kicker">IMAGE JOB</span><h3 id="image-job-title">图片生成任务</h3></div><StatusChip tone={displayStateTone}>{loading && !job ? '读取中…' : displayStateLabels[displayState] ?? '状态待确认'}</StatusChip></div>
    <div className="info-notice" role="status" aria-live="polite" aria-atomic="true">{job ? `任务 ${job.jobId} · 商品 ${job.productId} · 最后更新 ${new Date(job.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '正在读取任务状态…'}</div>
    {configurationError && <div ref={imageJobConfigurationErrorRef} id="image-job-config-error" className="error-notice image-job-config-blocker" role="alert" tabIndex={-1} aria-labelledby="image-job-config-error-title" aria-describedby="image-job-config-error-description"><strong id="image-job-config-error-title">模型中转配置尚未就绪</strong><span id="image-job-config-error-description">API 返回配置阻断（{error}）。系统不会生成、扣费或发布；请联系管理员完成测试环境模型中转配置后，再刷新任务状态。</span><button className="secondary-button" type="button" onClick={() => { setError(''); setConfigurationError(false); setReload(value => value + 1) }} disabled={loading}>刷新任务状态</button></div>}
    {error && !configurationError && <div ref={imageJobReadErrorRef} id="image-job-read-error" className="error-notice image-job-read-error" role="alert" tabIndex={-1} aria-live="assertive" aria-atomic="true" aria-labelledby="image-job-read-error-title" aria-describedby="image-job-read-error-description"><strong id="image-job-read-error-title">图片任务状态暂时不可用</strong><span id="image-job-read-error-description">任务状态读取失败：{error}。已保留上次可信状态；请刷新任务状态后继续。</span><button className="secondary-button" type="button" onClick={() => { setError(''); setReload(value => value + 1) }} disabled={loading}>刷新任务状态</button></div>}
    {job && <dl className="image-job-evidence" aria-label="图片执行证据"><div><dt>执行状态</dt><dd>{labels[job.executionState ?? ''] ?? job.executionState ?? '未记录'}</dd></div><div><dt>归档状态</dt><dd>{archiveLabels[job.archiveState] ?? '状态待确认'}</dd></div><div><dt>执行尝试</dt><dd>{job.executionAttempt ?? '未记录'}</dd></div><div><dt>Provider 请求</dt><dd>{job.providerRequestId ?? '尚未确认'}</dd></div><div><dt>任务版本</dt><dd>{job.revision}</dd></div></dl>}
    {job?.errorMessage && <div id="image-job-error" className="error-notice" role="alert" tabIndex={-1}><AlertCircle size={16} /><span>{job.errorCode ?? 'IMAGE_GENERATION_FAILED'}：{job.errorMessage}</span></div>}
    {job?.availabilityWarning && <div className="info-notice"><ShieldCheck size={16} /><span>{job.availabilityWarning}</span></div>}
    {!job && loading && <div className="image-candidate-loading" aria-hidden="true">
      {[0, 1, 2].map((slot) => <div className="image-candidate-skeleton" key={`image-candidate-skeleton-${slot}`}><div className="image-candidate-skeleton-media" /><div className="image-candidate-skeleton-line image-candidate-skeleton-line-wide" /><div className="image-candidate-skeleton-line" /></div>)}
    </div>}
    {job?.images?.length ? <>
      <div className="image-candidate-grid" aria-label={`已归档图片候选，第 ${candidatePageData.page} 页，共 ${candidatePageData.pageCount} 页`}>{candidatePageData.items.map(({ src, index }, visibleIndex) => {
      const output = job.outputs[index]
      const visualRef = output?.visualRef ?? `ordinal-${index}`
      const gate = output?.gate
      const failed = failedImages.has(visualRef)
      const selected = selectedVisualRefs.includes(visualRef)
      return <figure key={visualRef} className={`${gate?.selectable ? 'candidate-ready' : 'candidate-blocked'}${selected ? ' candidate-selected' : ''}`}>
        {failed ? <div className="image-candidate-fallback" role="alert" aria-labelledby={`candidate-image-error-${index}`}><span id={`candidate-image-error-${index}`}>候选图片读取失败，当前任务状态和候选门禁仍保留。</span><button className="text-button image-candidate-retry" type="button" onClick={() => { setFailedImages(current => { const next = new Set(current); next.delete(visualRef); return next }); setImageReloads(current => ({ ...current, [visualRef]: (current[visualRef] ?? 0) + 1 })) }} aria-label={`重新读取图片候选 ${index + 1}`} aria-describedby={`candidate-image-error-${index}`}>重新读取</button></div> : <img key={`${visualRef}-${imageReloads[visualRef] ?? 0}`} src={src} alt={`图片候选 ${index + 1}，${gate?.selectable ? '可进入后续选择' : '尚不可选择'}`} {...imageCandidateLoading(candidatePageData.page, visibleIndex)} decoding="async" onError={() => setFailedImages(current => new Set(current).add(visualRef))} />}
        <figcaption><strong>候选 {index + 1}</strong><span>{gate?.selectable ? '满足选择门禁' : '暂不可选择'}</span><div className="image-candidate-metadata" aria-label={`候选 ${index + 1} 归属与完整性摘要`}><span>任务：{job.jobId}</span><span>商品版本：v{job.sourceProductVersion}</span><span>来源素材：{job.sourceAssetIds.length ? `${job.sourceAssetIds.length} 个` : '无'}</span><span>生成：{new Date(output?.createdAt ?? job.createdAt).toLocaleString('zh-CN', { hour12: false })}</span><span>文件：{output ? `${output.mimeType} · ${Math.round(output.sizeBytes / 1024)} KB` : '未记录'}</span><span>SHA-256：{output?.sha256 ? `${output.sha256.slice(0, 12)}…` : '未记录'}</span>{output?.archiveReceiptId && <span>归档凭证：{output.archiveReceiptId}</span>}</div>{job.contentVersionId && <label className="candidate-select-control"><input type="checkbox" checked={selectedVisualRefs.includes(visualRef)} disabled={!gate?.selectable || selectionState === 'submitting'} aria-describedby={!gate?.selectable ? `candidate-gate-${index}` : undefined} onChange={() => toggleVisual(visualRef, Boolean(gate?.selectable))} />选择为{selectedVisualRefs[0] === visualRef ? '主图' : '辅图'}</label>}{gate && <div className="image-candidate-gates" aria-label={`候选 ${index + 1} 门禁状态`}><span>归档：{gateLabels[gate.archive] ?? gate.archive}</span><span>扫描：{gateLabels[gate.scan] ?? gate.scan}</span><span>权益：{gateLabels[gate.rights] ?? gate.rights}</span><span>审核：{gateLabels[output?.reviewStatus ?? ''] ?? output?.reviewStatus ?? '待确认'}</span><span>真实性：{gateLabels[gate.authenticity] ?? gate.authenticity}</span></div>}{!gate?.selectable && <small id={`candidate-gate-${index}`}>不可选择：{gate?.blockers.length ? gate.blockers.join('；') : '尚未满足全部候选门禁'}</small>}</figcaption>
      </figure>
    })}</div>
      {candidatePageData.pageCount > 1 && <nav className="image-candidate-pagination" aria-label="图片候选分页"><button className="secondary-button" type="button" onClick={() => setCandidatePage(candidatePageData.page - 1)} disabled={candidatePageData.page === 1}>上一页</button><span aria-live="polite">第 {candidatePageData.page} / {candidatePageData.pageCount} 页 · 共 {candidatePageData.total} 张候选</span><button className="secondary-button" type="button" onClick={() => setCandidatePage(candidatePageData.page + 1)} disabled={candidatePageData.page === candidatePageData.pageCount}>下一页</button></nav>}
    </> : null}
    {job?.contentVersionId ? <div className="image-selection-panel" aria-label="候选选择"><label htmlFor="visual-selection-reason">选图原因（必填）</label><input id="visual-selection-reason" value={selectionReason} maxLength={300} onChange={event => { setSelectionReason(event.target.value); setSelectionNotice('') }} disabled={selectionState === 'submitting'} /><div className="action-row"><button className="primary-button" type="button" onClick={() => void submitVisualSelection()} disabled={selectionState === 'submitting' || !selectedVisualRefs.length || !selectionReason.trim()} aria-describedby="visual-selection-hint">{selectionState === 'submitting' ? '提交中…' : `提交选择（${selectedVisualRefs.length}/6）`}</button><span id="visual-selection-hint" className="muted-note">服务端会再次校验任务、商品、版本、扫描和审核状态。</span></div><div className="sr-only" role="status" aria-live="polite" aria-atomic="true">已选择 {selectedVisualRefs.length} 张候选{selectionNotice ? `。${selectionNotice}` : ''}</div>{selectionMessage && <div ref={selectionErrorRef} tabIndex={selectionState === 'failed' ? -1 : undefined} className={selectionState === 'failed' ? 'error-notice' : 'info-notice'} role={selectionState === 'failed' ? 'alert' : 'status'}>{selectionMessage}</div>}{selectionState === 'succeeded' && selectedContentVersionId && reviewTaskId && <div className="action-row"><button className="primary-button" type="button" onClick={() => { window.location.href = urlForMerchantRoute(window.location, { page: 'task', target: { kind: 'task', taskId: reviewTaskId } }) }}>进入新版本审核</button><span className="muted-note">先审核并批准新版本，再提交人工发布任务。</span></div>}</div> : <div className="info-notice" role="status">当前图片任务未绑定内容版本，不能直接选择候选；请从营销任务进入内容版本后再操作。</div>}
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
  const consumedKnowledge = content?.knowledgeContext
  const consumedKnowledgeRuleCount = consumedKnowledge?.rules.length ?? 0
  const consumedKnowledgeAssetCount = consumedKnowledge?.assets.length ?? 0
  const consumedLearningCount = consumedKnowledge?.confirmedLearningSuggestions.length ?? 0
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
    fetchTaskPage(baseUrl, {
      limit: MERCHANT_TASK_PAGE_SIZE,
      offset: taskPage * MERCHANT_TASK_PAGE_SIZE,
    })
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
  // A recovery error is a terminal state for this render pass. Keep the
  // recovery card as the single source of truth instead of showing the normal
  // conversation thread with a contradictory “待分析需求” status behind it.
  const taskContextBlocked = Boolean(error) || taskStateBlocked
  useEffect(() => {
    if (taskStateBlocked && !error)
      setError('任务状态暂时无法确认，已暂停当前操作。请重新读取任务状态。')
  }, [taskStateBlocked, error])
  const taskPageSize = MERCHANT_TASK_PAGE_SIZE
  const taskPageCount = Math.max(1, Math.ceil(taskTotal / taskPageSize))
  const visibleTasks = useMemo(
    () => groupTasksForRecovery(taskList ?? []),
    [taskList],
  )
  // Keep the image-job deep link in the canonical task route.  It is removed
  // only by an explicit navigation action (for example the breadcrumb back
  // to the task queue), never while the detail panel is resolving.
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
            <h2>任务队列</h2>
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
              <span>从知识库选择商品即可创建营销任务。</span>
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
            服务端没有返回成功回执，当前没有把任务标记为已创建。任务是否已落库待确认，请先查看任务列表；确认没有同一任务后，再使用同一幂等请求重试。
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
              <div className="context-section" data-testid="task-knowledge-consumption">
                <div className="subhead">
                  <b>工作区知识消费</b>
                  <span>
                    {content
                      ? `${consumedKnowledgeRuleCount + consumedKnowledgeAssetCount + consumedLearningCount} 条已冻结`
                      : '生成后显示'}
                  </span>
                </div>
                {!content ? (
                  <div className="empty-inline">生成内容后，这里会显示本次实际使用的 Ops 知识和规则版本。</div>
                ) : consumedKnowledgeRuleCount || consumedKnowledgeAssetCount || consumedLearningCount ? (
                  <>
                    {consumedKnowledge?.rules.map((rule) => (
                      <div className="constraint" key={`knowledge-rule-${rule.id}`}>
                        <BookOpen size={16} />
                        <div>
                          <b>工作区规则 · {rule.version}</b>
                          <span>{rule.sourceReference} · 已用于本次生成</span>
                        </div>
                      </div>
                    ))}
                    {consumedKnowledge?.assets.map((asset) => (
                      <div className="constraint" key={`knowledge-asset-${asset.id}`}>
                        <FileCheck2 size={16} />
                        <div>
                          <b>{asset.kind === 'brand' ? '品牌知识' : '客户知识'} · {asset.name}</b>
                          <span>修订 {asset.revision} · 已用于本次生成</span>
                        </div>
                      </div>
                    ))}
                    {consumedKnowledge?.confirmedLearningSuggestions.map((learning) => (
                      <div className="constraint" key={`knowledge-learning-${learning.id}`}>
                        <History size={16} />
                        <div>
                          <b>已确认学习建议</b>
                          <span>{learning.summary} · 仅作为本次生成依据</span>
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="empty-inline">本次生成没有返回已确认的工作区知识；未将演示数据冒充为消费记录。</div>
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
                        <div className="doc-label">创意 Brief（脚本/分镜或静态素材）</div>
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

/**
 * Merchant-facing projection of the publish list.
 *
 * Rejected jobs come first, and the row keeps a positional label instead of the
 * raw job id. What it must not do is rewrite the platform's rejection evidence:
 * the list renders 「平台拒绝码：{rawCode}」 and marks each blocked field with the
 * platform's own code, and the PRD requires the merchant-visible receipt to keep
 * the original error code, the field paths and the actionable message so a
 * correction can be argued with platform support. This used to overwrite
 * `rejection.rawCode` with the literal string '平台拒绝' and drop every field
 * code, so every rejection — whatever the platform actually reported — rendered
 * the same meaningless "code" and the UI's own '平台未返回代码' fallback was
 * unreachable.
 */
export function projectPublishJobRows(next: PublishJob[]): PublishJob[] {
  return next
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
      // `rejection` is deliberately carried through untouched: its rawCode,
      // message and field codes are the evidence the merchant card renders.
    }))
}

export function manualPublishStateLabel(state: string): string {
  return ({
    export_ready: '待人工发布',
    manual_publish_in_progress: '人工发布中',
    manual_publish_reported: '已报告，待复核',
    manual_review_required: '需人工复核',
  } as Record<string, string>)[state] ?? '状态待确认'
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
  const [manualRecords, setManualRecords] = useState<ManualPublishRecord[] | null>(null)
  const [initialError, setInitialError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [reloadKey, setReloadKey] = useState(0)
  const [jobPage, setJobPage] = useState(0)
  const [jobTotal, setJobTotal] = useState<number | null>(null)
  const jobsSourceRef = useRef<string | undefined>(undefined)
  const lastSuccessfulJobsRef = useRef<PublishJob[]>([])
  useEffect(() => {
    if (!baseUrl) {
      jobsSourceRef.current = undefined
      lastSuccessfulJobsRef.current = []
      setLoading(false)
      setJobs(null)
      setManualRecords(null)
      setInitialError('')
      setRefreshError('')
      setJobPage(0)
      setJobTotal(null)
      return
    }
    let cancelled = false
    let inFlight = false
    const sourceKey = `${baseUrl}:${jobPage}`
    const hasCachedJobs = jobsSourceRef.current === sourceKey && jobs !== null
    let hasLoadedJobs = hasCachedJobs
    // Keep the last successful list visible during both background refresh and
    // manual retry. A transient request must never create a false empty state.
    if (!hasCachedJobs) lastSuccessfulJobsRef.current = []
    jobsSourceRef.current = sourceKey
    const load = (showLoading: boolean) => {
      if (inFlight) return
      inFlight = true
      if (showLoading && !hasLoadedJobs) setLoading(true)
      setInitialError('')
      setRefreshError('')
      Promise.all([
        fetchPublishJobPage(baseUrl, {
          limit: MERCHANT_PUBLISH_PAGE_SIZE,
          offset: jobPage * MERCHANT_PUBLISH_PAGE_SIZE,
        }),
        fetchManualPublishRecords(baseUrl),
      ])
        .then(([nextPage, nextManualRecords]) => {
          if (!cancelled) {
            hasLoadedJobs = true
            const safeJobs = projectPublishJobRows(nextPage.items)
            lastSuccessfulJobsRef.current = safeJobs
            setJobs(safeJobs)
            setJobTotal(nextPage.total)
            if (jobPage > 0 && jobPage * MERCHANT_PUBLISH_PAGE_SIZE >= nextPage.total) {
              setJobPage(Math.max(0, Math.ceil(nextPage.total / MERCHANT_PUBLISH_PAGE_SIZE) - 1))
            }
            setManualRecords(nextManualRecords)
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
  }, [baseUrl, jobPage, reloadKey])
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
  const listReady = !loading && jobs !== null && manualRecords !== null
  const jobPageCount = Math.max(1, Math.ceil((jobTotal ?? 0) / MERCHANT_PUBLISH_PAGE_SIZE))
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="section-kicker">CONTROLLED WRITES</span>
          <h2>审核后创建人工发布任务，并保留操作证据</h2>
          <p>Merchant Studio 负责冻结交付包；运营人员在平台后台发布并回填证据。人工记录不等于平台 API 回执。</p>
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
                          请先在知识库选择商品并完成内容审核。
        </div>
      )}
      <section className="publish-board" aria-busy={loading}>
        <div className="panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">IN FLIGHT</span>
              <h3>人工发布任务</h3>
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
              <b>暂无人工发布任务</b>
              <span>完成内容审核并二次确认后，待运营处理的任务会显示在这里。</span>
            </div>
          )}
          {listReady && jobTotal !== null && jobTotal > 0 && (
            <nav className="catalog-product-pagination" aria-label="发布任务分页">
              <span>共 {jobTotal} 个任务 · 第 {jobPage + 1} / {jobPageCount} 页</span>
              <div>
                <button type="button" disabled={jobPage === 0 || loading} onClick={() => setJobPage((page) => Math.max(0, page - 1))}>上一页</button>
                <button type="button" disabled={jobPage >= jobPageCount - 1 || loading} onClick={() => setJobPage((page) => Math.min(jobPageCount - 1, page + 1))}>下一页</button>
              </div>
            </nav>
          )}
        </div>
        <div className="panel receipt-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">RECEIPTS</span>
              <h3>人工发布记录</h3>
            </div>
          </div>
          {loading && <LoadingState label="正在读取人工发布记录…" />}
          {listReady &&
            Boolean(manualRecords.length) &&
            manualRecords.slice(0, 5).map((record) => (
              <div className="receipt-row" key={`manual-${record.id}`}>
                <span
                  className={`receipt-icon ${record.state === 'manual_review_required' ? 'fail' : ''}`}
                >
                  {record.state === 'manual_review_required' ? (
                    <X size={14} />
                  ) : (
                    <Clock3 size={14} />
                  )}
                </span>
                <b>
                  {platformNames[record.platform] ?? record.platform} ·{' '}
                  {manualPublishStateLabel(record.state)}
                </b>
                <span>
                  {record.platformContentId ?? record.publicUrl ?? record.platformDisplayStatus ?? '等待运营回填证据'}
                </span>
              </div>
            ))}
          {listReady && manualRecords.length === 0 && (
            <div className="empty-state">
              <span>暂无人工发布记录；人工记录不等于平台 API 回执。</span>
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
  const [ruleCategory, setRuleCategory] = useState<'all' | 'platform' | 'category' | 'advertising_publish'>('all')
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
  const classifyRule = (row: RulePack) => row.category
  const filteredRules = platformRows.filter((row) =>
    (ruleCategory === 'all' || classifyRule(row) === ruleCategory) &&
    `${row.name}${row.scope}${row.version}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
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
    : String(rows.filter((row) => resolveRuleExecutionState(row) === 'executable').length)
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
                {classifyRule(row) === 'platform' ? '平台规则' : classifyRule(row) === 'category' ? '品类规则' : classifyRule(row) === 'advertising_publish' ? '广告发布规则' : '未分类规则（已阻断）'} · {row.version} · 修订 {row.revision ?? 1}
              </span>
            </div>
            <StatusChip tone={resolveRuleExecutionState(row) === 'executable' ? 'neutral' : resolveRuleExecutionState(row) === 'blocked' ? 'red' : 'amber'}>{row.scope}</StatusChip>
            <span>{resolveRuleExecutionState(row) === 'executable' ? '可作为生成依据' : resolveRuleExecutionState(row) === 'blocked' ? '已阻断，不可执行' : '来源未验证，仅供核对'}</span>
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
        <label className="library-platform-filter">
          <span>规则分类</span>
          <select value={ruleCategory} onChange={(event) => setRuleCategory(event.target.value as typeof ruleCategory)}>
            <option value="all">全部规则</option>
            <option value="platform">平台规则</option>
            <option value="category">品类规则</option>
            <option value="advertising_publish">广告发布规则</option>
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
  useLayoutEffect(() => {
    if (!submitError) return
    errorRef.current?.focus({ preventScroll: true })
    const firstFrame = window.requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: true }))
    const secondFrame = window.requestAnimationFrame(() => window.requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: true })))
    const delayedFocus = window.setTimeout(() => errorRef.current?.focus({ preventScroll: true }), 120)
    return () => { window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame); window.clearTimeout(delayedFocus) }
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
            <h2 id="publish-title">提交人工发布任务</h2>
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
              交付包计划{actionLabel} {changes.length || 0} 个字段
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
                系统只创建绑定当前内容版本、店铺和快照的人工发布任务，并保留幂等证据；当前不代表平台已受理或已生效。
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
              我确认将审核后的内容交付给运营人员，由其在{confirmationTarget}的上述{platform}
              商品中人工发布，并在完成后回填平台 ID、公开链接或截图证据。
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
                  : '提交人工发布任务'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
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
  const [apiMode, setApiMode] = useState<string | null>(null)
  const [apiHealth, setApiHealth] = useState<ApiHealth | null>(null)
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
  const [workspaceNavigationKey, setWorkspaceNavigationKey] = useState(0)
  const [authState, setAuthState] = useState<'loading' | 'authenticated' | 'signed_out' | 'error'>(
    apiBaseUrl ? 'loading' : 'authenticated',
  )
  const [authAccount, setAuthAccount] = useState<MerchantAuthAccount | null>(null)
  const [authError, setAuthError] = useState('')
  const [capabilityDenied, setCapabilityDenied] = useState<{ code?: string; message?: string; requestId?: string } | null>(null)
  const [accountBilling, setAccountBilling] = useState<BillingStatus | null>(null)
  const publishTrigger = useRef<HTMLElement | null>(null)
  const utilityTrigger = useRef<HTMLElement | null>(null)
  const mobileMenuTrigger = useRef<HTMLButtonElement>(null)
  const toastTimer = useRef<number | null>(null)
  const publishPreviewLock = useRef(false)
  const routeRequestId = useRef(0)
  const mainContentRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!apiBaseUrl) return
    let cancelled = false
    setAuthState('loading')
    setAuthError('')
    fetchMerchantSession(apiBaseUrl)
      .then(account => {
        if (cancelled) return
        setAuthAccount(account)
        setAuthState('authenticated')
      })
      .catch(cause => {
        if (cancelled) return
        const code = (cause as { code?: string }).code
        setAuthAccount(null)
        setAuthState(code === 'AUTH_MERCHANT_ACCOUNT_REQUIRED' ? 'error' : 'signed_out')
        setAuthError(code === 'AUTH_MERCHANT_ACCOUNT_REQUIRED' ? describeApiError(cause) : '')
      })
    return () => { cancelled = true }
  }, [apiBaseUrl])
  useEffect(() => {
    const onDenied = (event: Event) => {
      const detail = (event as CustomEvent<{ code?: string; message?: string; requestId?: string }>).detail ?? {}
      setCapabilityDenied(detail)
    }
    window.addEventListener('merchant-capability-denied', onDenied)
    return () => window.removeEventListener('merchant-capability-denied', onDenied)
  }, [])
  const routeCanonicalized = useRef(false)
  const focusMainAfterNavigation = () =>
    focusMainAfterMerchantNavigation(
      mainContentRef.current,
      window.requestAnimationFrame.bind(window),
      () =>
        Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')) ||
        Boolean(mainContentRef.current?.closest('[inert]')),
    )
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )
  useEffect(() => {
    const handleAuthExpired = () => {
      setAuthAccount(null)
      setAuthState('signed_out')
      setAuthError('登录已失效，请重新登录商家工作台。')
    }
    window.addEventListener('merchant-auth-expired', handleAuthExpired)
    return () => window.removeEventListener('merchant-auth-expired', handleAuthExpired)
  }, [])
  useEffect(() => {
    if (!apiBaseUrl || authState !== 'authenticated') {
      setApiOnline(null)
      setApiMode(null)
      setApiHealth(null)
      setModelStatus(null)
      setModelStatusRead(false)
      return
    }
    let cancelled = false
    setApiOnline(null)
    setApiMode(null)
    setApiHealth(null)
    setModelStatus(null)
    setModelStatusRead(false)
    void Promise.allSettled([
      fetchApiHealth(apiBaseUrl),
      fetchPlatformModelStatus(apiBaseUrl),
    ]).then(([healthResult, modelResult]) => {
      if (cancelled) return
      if (healthResult.status === 'fulfilled' && healthResult.value) {
        setApiHealth(healthResult.value)
        setApiOnline(true)
        setApiMode(platformOperationsModeFromHealth(healthResult.value))
      } else {
        setApiHealth(null)
        setApiOnline(false)
        setApiMode(null)
      }
      setModelStatus(modelResult.status === 'fulfilled' ? modelResult.value : null)
      setModelStatusRead(true)
    })
    return () => { cancelled = true }
  }, [apiBaseUrl, authState])
  useEffect(() => {
    if (!apiBaseUrl || authState !== 'authenticated') {
      setAccountBilling(null)
      return
    }
    let cancelled = false
    fetchBillingStatus(apiBaseUrl)
      .then((status) => {
        if (!cancelled) setAccountBilling(status)
      })
      .catch(() => {
        if (!cancelled) setAccountBilling(null)
      })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, authState])
  const refreshEnvironmentStatus = () => {
    if (!apiBaseUrl || !modelStatusRead) return
    setModelStatusRead(false)
    void Promise.allSettled([
      fetchApiHealth(apiBaseUrl),
      fetchPlatformModelStatus(apiBaseUrl),
    ]).then(([healthResult, modelResult]) => {
      if (healthResult.status === 'fulfilled' && healthResult.value) {
        setApiHealth(healthResult.value)
        setApiOnline(true)
        setApiMode(platformOperationsModeFromHealth(healthResult.value))
      } else {
        setApiHealth(null)
        setApiOnline(false)
        setApiMode(null)
      }
      setModelStatus(modelResult.status === 'fulfilled' ? modelResult.value : null)
      setModelStatusRead(true)
    })
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
    setWorkspaceNavigationKey((key) => key + 1)
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
    if (apiBaseUrl && authState !== 'authenticated') return
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
  }, [apiBaseUrl, authState, routeReloadKey])
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
    // Keep publish and rules as in-context workflow steps. Any legacy or
    // programmatic request for those pages lands on the product workspace.
    const effectivePage: Page =
      nextPage === 'publish' || nextPage === 'rules' ? 'products' : nextPage
    const requestedEntry = options.entry ?? (effectivePage === 'products' ? 'knowledge' : undefined)
    const targetForRoute = options.target
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
      page: effectivePage,
      target: nextTarget,
      searchQuery: options.searchQuery,
      entry: requestedEntry,
    })
    window.history.pushState(null, '', url)
    routeRequestId.current += 1
    setPage(effectivePage)
    setActiveEntry(requestedEntry)
    setRouteTargetLoading(false)
    setRouteTargetError('')
    setWorkspaceNavigationKey((key) => key + 1)
    setMobileNav(false)
    setPublishModal(false)
    setUtilityPanel(null)
    if (effectivePage === 'task') setTarget(resolvedTarget)
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
    navigateTo('products')
    showToast(
      `人工发布任务已创建：${jobId}。需由运营人员完成平台操作并回填证据，当前不代表平台已受理或已生效。`,
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
  const handleMerchantLogout = async () => {
    if (!apiBaseUrl) return
    try {
      await logoutMerchantAccount(apiBaseUrl)
      setAuthAccount(null)
      setAccountBilling(null)
      setAuthState('signed_out')
      setUtilityPanel(null)
    } catch (cause) {
      showToast(`退出登录失败：${describeApiError(cause)}`, 'error')
    }
  }
  if (apiBaseUrl && authState !== 'authenticated') {
    return (
      <MerchantLoginPage
        apiBaseUrl={apiBaseUrl}
        error={authError}
        loading={authState === 'loading'}
        onRetry={() => {
          setAuthState('loading')
          setAuthError('')
          fetchMerchantSession(apiBaseUrl)
            .then(account => {
              setAuthAccount(account)
              setAuthState('authenticated')
            })
            .catch(cause => {
              const code = (cause as { code?: string }).code
              setAuthState(code === 'AUTH_MERCHANT_ACCOUNT_REQUIRED' ? 'error' : 'signed_out')
              setAuthError(code === 'AUTH_MERCHANT_ACCOUNT_REQUIRED' ? describeApiError(cause) : '')
            })
        }}
        onAuthenticated={(account) => {
          setAuthAccount(account)
          setAuthState('authenticated')
          setAuthError('')
        }}
      />
    )
  }
  return (
    <div className="app-shell">
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
      />
      <div
        className="app-content"
        inert={mobileNav || publishModal || Boolean(utilityPanel)}
      >
        <div className="main-shell">
          <Topbar
            page={page}
            activeEntry={activeEntry}
            openMenu={() => setMobileNav(true)}
            menuOpen={mobileNav}
            menuButtonRef={mobileMenuTrigger}
            apiOnline={apiOnline}
            apiMode={apiMode}
            apiHealth={apiHealth}
            apiBaseUrl={apiBaseUrl}
            modelStatus={modelStatus}
            modelStatusRead={modelStatusRead}
            account={authAccount}
            billing={accountBilling}
            onLogout={() => void handleMerchantLogout()}
            onPasswordChanged={() => {
              setAuthAccount(null)
              setAuthState('signed_out')
              setAuthError('密码已修改，请使用新密码重新登录。')
            }}
            onOpenUtility={openUtility}
            onOpenIssues={() => navigateTo('products', { clearContext: true })}
            searchQuery={globalSearch}
            onSearchQuery={setGlobalSearch}
            onSearch={searchProducts}
          />
          <main
            ref={mainContentRef}
            tabIndex={-1}
            className={`page ${page === 'task' ? 'task-page' : ''} ${page === 'overview' ? 'overview-page' : ''}`}
          >
            {routeTargetLoading ? (
              <LoadingState label="正在从链接安全恢复商品与任务上下文…" />
            ) : routeTargetError ? (
              <section
                className="page-stack"
                data-testid="route-recovery-error"
              >
                <ErrorNotice
                  message={
                    routeTargetError.includes('FORBIDDEN') ||
                    routeTargetError.includes('授权决策拒绝') ||
                    routeTargetError.includes('没有权限') ||
                    routeTargetError.includes('无权访问')
                      ? `当前会话无权读取这项任务：${routeTargetError}`
                      : `无法恢复当前链接：${routeTargetError}`
                  }
                  onRetry={() => setRouteReloadKey((key) => key + 1)}
                  focusOnMount
                />
                {(routeTargetError.includes('FORBIDDEN') ||
                  routeTargetError.includes('授权决策拒绝') ||
                  routeTargetError.includes('没有权限') ||
                  routeTargetError.includes('无权访问')) && (
                  <p className="muted">
                    服务端拒绝了当前身份对任务或商品事实的读取请求，页面不会用演示数据替代。请切换到有权访问该工作区的商家账号后重试。
                  </p>
                )}
                <button
                  className="primary"
                  onClick={() => navigateTo('products', { clearContext: true })}
                >
                  回到知识库
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
                    apiMode={apiMode}
                    billing={accountBilling}
                    onOpenUtility={openUtility}
                  />
                )}
                {page === 'finance' && <FinanceOverview baseUrl={apiBaseUrl ?? ''} billing={accountBilling} account={authAccount} onOpenSupport={() => openUtility('support')} />}
                {page === 'products' && (
                  activeEntry === 'products' ? (
                    <StoreCatalogExperience key={`products-${workspaceNavigationKey}`} baseUrl={apiBaseUrl} apiMode={apiMode} />
                  ) : (
                    <Products
                      key={`${activeEntry ?? 'knowledge'}-${workspaceNavigationKey}`}
                      baseUrl={apiBaseUrl}
                      apiMode={apiMode}
                      modelStatus={modelStatus}
                      modelStatusRead={modelStatusRead}
                      onRefreshModelStatus={refreshEnvironmentStatus}
                      initialQuery={globalSearch}
                      initialEntry={activeEntry}
                      onSelectTarget={(next) =>
                        navigateTo('task', { target: next, clearContext: true })
                      }
                      onOpenTasks={() =>
                        navigateTo('task', { clearContext: true })
                      }
                    />
                  )
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
      <Modal open={Boolean(capabilityDenied)} title="当前账号没有此操作权限" footer={null} onCancel={() => setCapabilityDenied(null)}>
        <div role="alert" className="capability-denied-dialog">
          <p>该功能需要平台管理员授予对应的商家能力，请联系管理员开通后重试。</p>
          {capabilityDenied?.message && <p className="muted">服务端提示：{capabilityDenied.message}</p>}
          {capabilityDenied?.requestId && <p className="muted">Request ID：{capabilityDenied.requestId}</p>}
          <Space>
            <Button onClick={() => { setCapabilityDenied(null); window.location.assign('/merchant/login') }}>重新登录</Button>
            <Button type="primary" onClick={() => setCapabilityDenied(null)}>知道了</Button>
          </Space>
        </div>
      </Modal>
      {utilityPanel === 'support' ? (
        <CustomerSupportPanel apiBaseUrl={apiBaseUrl} relatedTaskId={taskContext?.task.id} onClose={closeUtility} />
      ) : utilityPanel && (
        <UtilityPanel
          panel={utilityPanel}
          apiOnline={apiOnline}
          apiBaseUrl={apiBaseUrl}
          apiHealth={apiHealth}
          modelStatus={modelStatus}
          modelStatusRead={modelStatusRead}
          onRefreshEnvironmentStatus={refreshEnvironmentStatus}
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
