import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Form } from "antd";
import { describeOpsError, hasOpsConnection, managedOpsSession, readOpsConnectionConfig, rpc, rpcForWorkspace } from "../api/opsClient.js";
import type {
  Platform,
  Settings,
  PlatformSetting,
  Audit,
  Subscription,
  Order,
  Member,
  PlatformUserDirectory,
  PlatformUserDetail,
  WorkspaceSummary,
  WorkspaceDirectoryPage,
  Offer,
  Addon,
  Coupon,
  Rollout,
  ModelMarkupPolicy,
  GrowthFunnel,
  OperationalAlert,
  ModelStatus,
  Rule,
  RuleSyncStatus,
  KnowledgeAsset,
  LearningSuggestion,
  CompetitorAnalysis,
  WorkspaceMetrics,
  UploadedAssetRisk,
  MarketingQueue,
  QueueFilters,
  AlertFilters,
  PlatformHealth,
  PlatformOperation,
  StoreDirectory,
  BrandNavigationItem,
  DataLifecycle,
  EvidenceReadiness,
  DataDeletionRequest,
  Reconciliation,
  RechargeOrderList,
  RechargeOrderState,
  ModelUsageSettlementRecord,
  AutomationPolicy,
  AutomationScan,
  OpsSession,
  PlatformTaskSummary,
  PlatformBrandUnitSummary,
  CanonicalProductConsistencyReport,
  PlatformMarketingSummary,
  PlatformModelUsageSummary,
  OpsDataSource,
  RpcErrorPayload,
  Rpc,
  OpsRequestError,
} from "../types/ops.js";
import { financePermissions, runAuthorizedFinanceAction } from "../components/finance/financePermissions.js";
import { rechargeOrderListParams } from "../components/finance/rechargeOrders.js";
import { applyLoadedValue, OpsLoadCoordinator } from "./opsLoadCoordinator.js";
import { submitRevisionCreation, type RevisionCreationValues } from "../components/tasks/knowledge/revisionCreation.js";
import { auditCenterClient, featureFlagsClient, financeSearchClient, incidentsClient, supportClient } from "../api/opsDomainClients.js";
import { createAuthorizationProjection, type AuthorizationProjection } from "../authz/authorization.js";
import type { CapabilityId } from "../../../../packages/contracts/src/authz.js";

export interface OpsLoadFilterOverrides {
  queueFilters?: QueueFilters;
  alertFilters?: AlertFilters;
}

export type OpsDataSetErrors = Readonly<Record<string, string>>;
export type OpsDataSetErrorEvidence = Readonly<Record<string, Pick<OpsRequestError, "requestId" | "traceId" | "code" | "details">>>;

export function dataSetErrorEvidenceFor(
  errors: OpsDataSetErrorEvidence,
  methods: readonly string[],
): Pick<OpsRequestError, "requestId" | "traceId" | "code" | "details"> | undefined {
  return methods.map((method) => errors[method]).find(Boolean);
}

/** Canonical capability policy for post-session background hydration. */
export const OPS_BACKGROUND_HYDRATION_POLICY = {
  "workspace.commercial.get": "workspace.summary.read",
  "ops.audit.platform.list": "audit.read",
  "ops.audit.list": "audit.read",
  "ops.members.list": "workspace.member.read",
  "ops.workspaces.list": "workspace.directory.read",
  "ops.stores.list": "workspace.directory.read",
  "ops.brand-units.summary": "workspace.directory.read",
  "canonical.product.consistency": "customer.content.read",
  "ops.tasks.summary": "workspace.directory.read",
  "ops.marketing.summary": "marketing.summary.read",
  "ops.model-usage.summary": "billing.platform.read",
  "billing.model-usage.statement": "billing.workspace.read",
  "ops.commercial.offers.list": "commercial.read",
  "ops.commercial.addons.list": "commercial.read",
  "ops.commercial.coupons.list": "commercial.read",
  "ops.commercial.rollouts.list": "commercial.read",
  "ops.growth.funnel": "workspace.directory.read",
  "workspace.health": "workspace.summary.read",
  "ops.alerts.list": "marketing.summary.read",
  "ops.data.delete.list": "workspace.delete.execute",
  "platform.model.status": "model.status.read",
  "workspace.metrics": "workspace.summary.read",
  "ops.storage.reconciliation.list": "storage.reconciliation.read",
  "knowledge.rule.list": "customer.content.read",
  "knowledge.asset.list": "customer.content.read",
  "knowledge.learning.list": "customer.content.read",
  "knowledge.competitor.list": "customer.content.read",
  "ops.marketing.queue": "marketing.queue.read",
  "automation.policy.get": "automation.read",
  "automation.policy.list": "automation.read",
  "automation.scan": "automation.read",
} as const satisfies Readonly<Record<string, CapabilityId>>;

export type OpsBackgroundHydrationMethod = keyof typeof OPS_BACKGROUND_HYDRATION_POLICY;

export function allowedBackgroundHydrationMethods(
  authorization: Pick<AuthorizationProjection, "can">,
): ReadonlySet<OpsBackgroundHydrationMethod> {
  return new Set(
    (Object.entries(OPS_BACKGROUND_HYDRATION_POLICY) as Array<[OpsBackgroundHydrationMethod, CapabilityId]>)
      .filter(([, capability]) => authorization.can(capability))
      .map(([method]) => method),
  );
}

export function dataSetErrorFor(
  errors: OpsDataSetErrors,
  methods: readonly string[],
): string | undefined {
  const failedMethods = methods.filter((method) => errors[method]);
  const fatal = errors["*"];
  if (!failedMethods.length) return fatal;
  const messages = [...new Set(failedMethods.map((method) => errors[method]))];
  return `部分数据集刷新失败（${failedMethods.join("、")}）。页面保留上次成功数据，这些值可能已过期：${messages.join("；")}`;
}

export type DataDeletionDecision = "approve" | "cancel";

export const DATA_DELETION_REASON_MIN_LENGTH = 4;

export const PUBLISH_BATCH_REASON_MIN_LENGTH = 4;

export function offerChangeErrors(offer: Offer): { validFrom?: string; validTo?: string; reason?: string } {
  const validFromTime = Date.parse(offer.validFrom);
  const validToTime = offer.validTo?.trim() ? Date.parse(offer.validTo) : undefined;
  return {
    ...(!offer.validFrom.trim() || !Number.isFinite(validFromTime) ? { validFrom: "请输入有效的套餐生效时间" } : {}),
    ...(validToTime !== undefined && (!Number.isFinite(validToTime) || validToTime <= validFromTime) ? { validTo: "失效时间必须晚于生效时间" } : {}),
    ...(!offer.changeReason?.trim() ? { reason: "请输入本次套餐变更原因" } : {}),
  };
}

export function normalizePublishBatchPauseReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length < PUBLISH_BATCH_REASON_MIN_LENGTH)
    throw new Error(`暂停原因至少填写 ${PUBLISH_BATCH_REASON_MIN_LENGTH} 个字符`);
  return normalized;
}

export function normalizePublishBatchConfirmations(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("失败项确认必须是有效 JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50)
    throw new Error("失败项确认必须包含 1 至 50 个项目");
  const required = ["task_id", "content_version_id", "confirmation_hash", "remote_snapshot_hash", "idempotency_key"] as const;
  if (parsed.some((item) => !item || typeof item !== "object" || required.some((key) => typeof (item as Record<string, unknown>)[key] !== "string" || !(item as Record<string, string>)[key].trim())))
    throw new Error(`每个失败项都必须包含 ${required.join("、")}`);
  return JSON.stringify(parsed);
}

export function normalizeDataDeletionReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length < DATA_DELETION_REASON_MIN_LENGTH)
    throw new Error(`请填写至少 ${DATA_DELETION_REASON_MIN_LENGTH} 个字符的具体原因`);
  return normalized;
}

export async function submitDataDeletionDecision(input: {
  decision: DataDeletionDecision;
  requestId: string;
  reason: string;
  request?: (method: string, params: Record<string, string>) => Promise<unknown>;
  refresh: () => Promise<unknown>;
}): Promise<void> {
  const reason = normalizeDataDeletionReason(input.reason);
  await (input.request ?? rpc)(`ops.data.delete.${input.decision}`, {
    request_id: input.requestId,
    reason,
  });
  // The decision is already durable. Refresh the broad console snapshot in
  // the background so the confirmation dialog is not held open by unrelated
  // datasets or their timeouts.
  void input.refresh().catch(() => undefined);
}

export function alertListParams(filters: AlertFilters, platformScope = false): Record<string, string> {
  return {
    status: "open",
    limit: "100",
    ...(platformScope ? { platform_scope: "platform" } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.accountId ? { account_id: filters.accountId } : {}),
    ...(filters.code ? { code: filters.code } : {}),
    ...(filters.entityType ? { entity_type: filters.entityType } : {}),
    ...(filters.entityId ? { entity_id: filters.entityId } : {}),
  };
}

export function marketingQueueParams(filters: QueueFilters): Record<string, string> {
  return {
    limit: "50",
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.accountId ? { account_id: filters.accountId } : {}),
    ...(filters.productId ? { product_id: filters.productId } : {}),
    ...(filters.taskId ? { task_id: filters.taskId } : {}),
    ...(filters.state ? { state: filters.state } : {}),
  };
}

export function prepareAutomationScopeLoad(
  scope: string,
  stores: readonly StoreDirectory[],
  clear: {
    setScope: (value: string) => void;
    setPolicy: (value: AutomationPolicy | undefined) => void;
    setScan: (value: AutomationScan | undefined) => void;
  },
): Record<string, string> {
  clear.setScope(scope);
  clear.setPolicy(undefined);
  clear.setScan(undefined);
  const row = stores.find((item) => `${item.platform}:${item.accountId}` === scope);
  return row ? { platform: row.platform, account_id: row.accountId } : {};
}

export class IdempotencyOperationKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly createKey: () => string = () => crypto.randomUUID()) {}

  keyFor(operation: string) {
    const existing = this.keys.get(operation);
    if (existing) return existing;
    const created = this.createKey();
    this.keys.set(operation, created);
    return created;
  }

  release(operation: string) {
    this.keys.delete(operation);
  }
}

export async function runIdempotentOperation<T>(
  keys: IdempotencyOperationKeys,
  operation: string,
  request: (idempotencyKey: string) => Promise<T>,
): Promise<T> {
  const idempotencyKey = keys.keyFor(operation);
  try {
    const result = await request(idempotencyKey);
    keys.release(operation);
    return result;
  } catch (cause) {
    if ((cause as OpsRequestError | undefined)?.code !== "API_REQUEST_TIMEOUT")
      keys.release(operation);
    throw cause;
  }
}

export class UserRequestGate {
  private directory?: AbortController;
  private detail?: AbortController;
  private exportJob?: AbortController;

  beginDirectory() {
    this.directory?.abort();
    return (this.directory = new AbortController());
  }

  beginDetail() {
    this.detail?.abort();
    return (this.detail = new AbortController());
  }

  beginExport() {
    if (this.exportJob) return undefined;
    return (this.exportJob = new AbortController());
  }

  finishDirectory(controller: AbortController) { if (this.directory === controller) this.directory = undefined; }
  finishDetail(controller: AbortController) { if (this.detail === controller) this.detail = undefined; }
  finishExport(controller: AbortController) {
    if (this.exportJob !== controller) return false;
    this.exportJob = undefined;
    return true;
  }

  cancelAll() {
    this.directory?.abort();
    this.detail?.abort();
    this.exportJob?.abort();
    this.directory = undefined;
    this.detail = undefined;
    this.exportJob = undefined;
  }
}

export function useOpsConsoleModel() {
  const { message, modal } = AntApp.useApp();
  const [settings, setSettings] = useState<Settings>();
  const [platformRows, setPlatformRows] = useState<PlatformSetting[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [subscription, setSubscription] = useState<Subscription>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [userDirectory, setUserDirectory] = useState<PlatformUserDirectory>({
    items: [],
    total: 0,
    identityCount: 0,
    workspaceCount: 0,
    offset: 0,
    limit: 20,
    truncated: false,
  });
  const [userDirectoryLoading, setUserDirectoryLoading] = useState(false);
  const [userDirectoryError, setUserDirectoryError] = useState("");
  const userDirectoryRequestRef = useRef(0);
  const [userExporting, setUserExporting] = useState(false);
  const [userDetail, setUserDetail] = useState<PlatformUserDetail>();
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const userDetailRequestRef = useRef(0);
  const [userDirectoryFilters, setUserDirectoryFilters] = useState<{ query?: string; status?: string; workspaceId?: string; page?: number; pageSize?: number }>({});
  const [workspaceRows, setWorkspaceRows] = useState<WorkspaceSummary[]>([]);
  const [workspaceDirectory, setWorkspaceDirectory] = useState<WorkspaceDirectoryPage>({ items: [], total: 0, offset: 0, limit: 20, hasMore: false });
  const [workspaceDirectoryLoading, setWorkspaceDirectoryLoading] = useState(false);
  const workspaceDirectoryRequestRef = useRef(0);
  const [reconciliation, setReconciliation] = useState<Reconciliation>();
  const [rechargeOrders, setRechargeOrders] = useState<RechargeOrderList>();
  const [rechargeOrdersLoading, setRechargeOrdersLoading] = useState(false);
  const [rechargeOrdersError, setRechargeOrdersError] = useState("");
  const [rechargeOrderStateFilter, setRechargeOrderStateFilter] = useState<RechargeOrderState>();
  const [queryingRechargeOrderId, setQueryingRechargeOrderId] = useState<string>();
  const rechargeOrdersRequestRef = useRef(0);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [rollouts, setRollouts] = useState<Rollout[]>([]);
  const [modelMarkup, setModelMarkup] = useState<ModelMarkupPolicy>();
  const [modelMarkupReason, setModelMarkupReason] = useState("");
  const [funnel, setFunnel] = useState<GrowthFunnel>({
    counts: {},
    totalEvents: 0,
  });
  const [platformHealth, setPlatformHealth] = useState<
    Record<string, PlatformHealth>
  >({});
  const [platformOperations, setPlatformOperations] = useState<
    PlatformOperation[]
  >([]);
  const [storeDirectory, setStoreDirectory] = useState<StoreDirectory[]>([]);
  const [brandNavigation, setBrandNavigation] = useState<BrandNavigationItem[]>([]);
  const [dataLifecycle, setDataLifecycle] = useState<DataLifecycle>({
    state: "not_required",
  });
  const [productionEvidence, setProductionEvidence] = useState<{
    capability: EvidenceReadiness;
    capacity: EvidenceReadiness;
  }>({
    capability: { state: "not_required" },
    capacity: { state: "not_required" },
  });
  const [alerts, setAlerts] = useState<OperationalAlert[]>([]);
  const [deletionRequests, setDeletionRequests] = useState<
    DataDeletionRequest[]
  >([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>();
  const [modelStatusLoading, setModelStatusLoading] = useState(true);
  const [rules, setRules] = useState<Rule[]>([]);
  const [ruleSyncStatuses, setRuleSyncStatuses] = useState<RuleSyncStatus[]>([]);
  const [ruleSyncLoading, setRuleSyncLoading] = useState(false);
  const [ruleMutationKey, setRuleMutationKey] = useState<string>();
  const ruleMutationInFlight = useRef(false);
  const [knowledgeRules, setKnowledgeRules] = useState<Rule[]>([]);
  const [knowledgeAssets, setKnowledgeAssets] = useState<KnowledgeAsset[]>([]);
  const [learningSuggestions, setLearningSuggestions] = useState<
    LearningSuggestion[]
  >([]);
  const [competitors, setCompetitors] = useState<CompetitorAnalysis[]>([]);
  const [workspaceMetrics, setWorkspaceMetrics] = useState<WorkspaceMetrics>();
  const [storageReconciliationWorkspaces, setStorageReconciliationWorkspaces] = useState<NonNullable<WorkspaceMetrics["storageReconciliation"]>[]>([]);
  const [marketingQueue, setMarketingQueue] = useState<MarketingQueue>({
    generation: [],
    publish: [],
    visuals: [],
    batches: [],
    learningSuggestions: [],
    assetRisks: [],
    uploadedAssetRisks: [],
    imageExecutions: [],
  });
  const [platformTaskSummary, setPlatformTaskSummary] = useState<PlatformTaskSummary>();
  const [platformBrandUnitSummary, setPlatformBrandUnitSummary] = useState<PlatformBrandUnitSummary>();
  const [canonicalProductConsistency, setCanonicalProductConsistency] = useState<CanonicalProductConsistencyReport>();
  const [platformMarketingSummary, setPlatformMarketingSummary] = useState<PlatformMarketingSummary>();
  const [platformModelUsageSummary, setPlatformModelUsageSummary] = useState<PlatformModelUsageSummary>();
  const [queueFilters, setQueueFilters] = useState<QueueFilters>({});
  const [alertFilters, setAlertFilters] = useState<AlertFilters>({});
  const [automationPolicy, setAutomationPolicy] = useState<AutomationPolicy>();
  const [automationPolicies, setAutomationPolicies] = useState<
    AutomationPolicy[]
  >([]);
  const [automationScan, setAutomationScan] = useState<AutomationScan>();
  const [automationScope, setAutomationScope] = useState("");
  const [selectedStoreScope, setSelectedStoreScope] = useState("");
  const [opsSession, setOpsSession] = useState<OpsSession>();
  const opsSessionRef = useRef<OpsSession | undefined>(undefined);
  opsSessionRef.current = opsSession;
  const [dataSource, setDataSource] = useState<OpsDataSource>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [dataSetErrors, setDataSetErrors] = useState<Record<string, string>>({});
  const [dataSetErrorEvidenceByMethod, setDataSetErrorEvidence] = useState<Record<string, Pick<OpsRequestError, "requestId" | "traceId" | "code" | "details">>>({});
  const loadCoordinatorRef = useRef(new OpsLoadCoordinator());
  const automationScopeRequestRef = useRef(0);
  const identityOperationKeysRef = useRef(new IdempotencyOperationKeys());
  const [memberForm] = Form.useForm();
  const [refundForm] = Form.useForm();
  const [ruleForm] = Form.useForm();
  const [knowledgeRuleForm] = Form.useForm();
  const [knowledgeAssetForm] = Form.useForm();
  const [competitorForm] = Form.useForm();
  const loadInFlightKeysRef = useRef(new Set<string>());
  const userDirectoryInFlightKeysRef = useRef(new Set<string>());
  const userRequestsRef = useRef(new UserRequestGate());

  const cancelUserRequests = () => {
    userDirectoryRequestRef.current += 1;
    userDetailRequestRef.current += 1;
    userRequestsRef.current.cancelAll();
    userDirectoryInFlightKeysRef.current.clear();
    setUserDirectoryLoading(false);
    setUserDetailLoading(false);
    setUserExporting(false);
  };

  // Authorization boundary changes must not leave a previously authorized
  // response visible while the replacement session is being fetched. Clear
  // every server-backed dataset first; the subsequent load repopulates only
  // what the new projection allows.
  const clearAuthorizationScopedData = () => {
    loadCoordinatorRef.current.begin();
    loadInFlightKeysRef.current.clear();
    cancelUserRequests();
    setSettings(undefined);
    setPlatformRows([]);
    setAudits([]);
    setSubscription(undefined);
    setOrders([]);
    setMembers([]);
    setUserDirectory({ items: [], total: 0, identityCount: 0, workspaceCount: 0, offset: 0, limit: 20, truncated: false });
    setUserDirectoryError("");
    setUserDetail(undefined);
    setWorkspaceRows([]);
    setWorkspaceDirectory({ items: [], total: 0, offset: 0, limit: 20, hasMore: false });
    setReconciliation(undefined);
    setRechargeOrders(undefined);
    setRechargeOrdersError("");
    setOffers([]);
    setAddons([]);
    setCoupons([]);
    setRollouts([]);
    setModelMarkup(undefined);
    setFunnel({ counts: {}, totalEvents: 0 });
    setPlatformHealth({});
    setPlatformOperations([]);
    setStoreDirectory([]);
    setBrandNavigation([]);
    setAlerts([]);
    setDeletionRequests([]);
    setModelStatus(undefined);
    setRules([]);
    setRuleSyncStatuses([]);
    setKnowledgeRules([]);
    setKnowledgeAssets([]);
    setLearningSuggestions([]);
    setCompetitors([]);
    setWorkspaceMetrics(undefined);
    setStorageReconciliationWorkspaces([]);
    setMarketingQueue({ generation: [], publish: [], visuals: [], batches: [], learningSuggestions: [], assetRisks: [], uploadedAssetRisks: [], imageExecutions: [] });
    setPlatformTaskSummary(undefined);
    setPlatformBrandUnitSummary(undefined);
    setCanonicalProductConsistency(undefined);
    setPlatformMarketingSummary(undefined);
    setPlatformModelUsageSummary(undefined);
    setAutomationPolicy(undefined);
    setAutomationPolicies([]);
    setAutomationScan(undefined);
    setAutomationScope("");
    setSelectedStoreScope("");
    opsSessionRef.current = undefined;
    setOpsSession(undefined);
    setDataSetErrors({});
    setDataSetErrorEvidence({});
    setError("");
  };

  const load = async (filterOverrides: OpsLoadFilterOverrides = {}) => {
    const activeQueueFilters = filterOverrides.queueFilters ?? queueFilters;
    const activeAlertFilters = filterOverrides.alertFilters ?? alertFilters;
    const loadKey = JSON.stringify({ activeQueueFilters, activeAlertFilters });
    if (loadInFlightKeysRef.current.has(loadKey)) return;
    loadInFlightKeysRef.current.add(loadKey);
    const loadRequest = loadCoordinatorRef.current.begin();
    setLoading(true);
    setModelStatusLoading(true);
    setError("");
    if (!hasOpsConnection()) {
      loadInFlightKeysRef.current.delete(loadKey);
      setLoading(false);
      setModelStatusLoading(false);
      return;
    }
    try {
      let firstOptionalError: unknown;
      const failedDataSets: string[] = [];
      const failedDataSetErrors: Record<string, string> = {};
      const failedDataSetErrorEvidence: Record<string, Pick<OpsRequestError, "requestId" | "traceId" | "code" | "details">> = {};
      let activeLoads = 0;
      const loadWaiters: Array<() => void> = [];
      const scheduledRpc = async (method: string, params: Record<string, string> = {}) => {
        // Bound background hydration without turning one slow optional domain
        // into a multi-minute serial waterfall. Route-critical clients still
        // run outside this queue.
        if (activeLoads >= 4) await new Promise<void>((resolve) => loadWaiters.push(resolve));
        activeLoads += 1;
        try {
          return await rpc(method, params);
        } finally {
          activeLoads -= 1;
          loadWaiters.shift()?.();
        }
      };
      const optional = async (
        method: string,
        params: Record<string, string> = {},
      ): Promise<Rpc["result"] | undefined> => {
        try {
          return await scheduledRpc(method, params);
        } catch (cause) {
          firstOptionalError ??= cause;
          failedDataSets.push(method);
          failedDataSetErrors[method] = describeOpsError(cause);
          const evidence = cause as Partial<OpsRequestError>;
          failedDataSetErrorEvidence[method] = {
            ...(typeof evidence.requestId === "string" ? { requestId: evidence.requestId } : {}),
            ...(typeof evidence.traceId === "string" ? { traceId: evidence.traceId } : {}),
            ...(typeof evidence.code === "string" ? { code: evidence.code } : {}),
            ...(evidence.details && typeof evidence.details === "object" ? { details: evidence.details } : {}),
          };
          return undefined;
        }
      };
      // Resolve the managed session before constructing the rest of the load
      // matrix. Otherwise the first render can briefly issue workspace-scoped
      // requests before the canonical capability projection arrives from the gateway.
      let resolvedSession = opsSessionRef.current;
      if (!resolvedSession) {
        const value = await optional("ops.session");
        if (value && typeof value === "object" && !Array.isArray(value)) {
          resolvedSession = value as unknown as OpsSession;
          loadCoordinatorRef.current.commit(loadRequest, () => { opsSessionRef.current = resolvedSession; setOpsSession(resolvedSession!); });
        }
      }
      const resolvedAuthorization = createAuthorizationProjection(resolvedSession, managedOpsSession);
      const allowedHydrationMethods = allowedBackgroundHydrationMethods(resolvedAuthorization);
      const authorizedOptional = (
        method: OpsBackgroundHydrationMethod,
        params: Record<string, string> = {},
      ) => allowedHydrationMethods.has(method) ? optional(method, params) : Promise.resolve(undefined);
      const hasCustomerDataRole = resolvedAuthorization.canAny(["customer.content.read", "marketing.queue.read"]);
      // A local bearer can carry platform roles while the operator is still
      // on the workspace workbench. The request context, not raw roles, is
      // authoritative for avoiding platform-only 403s during hydration.
      const platformOperator = resolvedAuthorization.scope.kind === 'platform';
      const platformAlertScope = platformOperator && resolvedAuthorization.can("marketing.summary.read");
      const platformStoreScope = platformOperator && resolvedAuthorization.can("platform.settings.read");
      const [
        sessionResult,
        result,
        auditResult,
        membersResult,
        workspacesResult,
        storesResult,
        brandUnitSummaryResult,
        canonicalProductConsistencyResult,
        taskSummaryResult,
        marketingSummaryResult,
        modelUsageSummaryResult,
        financeResult,
        offerResult,
        addonResult,
        couponResult,
        rolloutResult,
        funnelResult,
        healthResult,
        alertResult,
        deletionResult,
        modelResult,
        metricsResult,
        storageReconciliationResult,
        knowledgeRuleResult,
        assetResult,
        learningResult,
        competitorResult,
        queueResult,
        automationResult,
        automationListResult,
        automationScanResult,
      ] = await Promise.all([
        // Local acceptance still has a real API session (the bearer token
        // carries the operator roles). Resolve it before deriving member,
        // incident and workspace permissions; otherwise local mode silently
        // falls back to an empty workspace and renders every mutation form
        // disabled.
        resolvedSession ? Promise.resolve(resolvedSession) : optional("ops.session"),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("workspace.commercial.get"),
        platformOperator ? authorizedOptional("ops.audit.platform.list", { limit: "50" }) : authorizedOptional("ops.audit.list", {
          ...(localStorage.getItem("ops_workspace_id")?.trim() ? { workspace_id: localStorage.getItem("ops_workspace_id")!.trim() } : {}),
          limit: "50",
        }),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("ops.members.list"),
        platformOperator && allowedHydrationMethods.has("ops.workspaces.list")
          ? new Promise<void>((resolve) => window.setTimeout(resolve, 1_500)).then(() => authorizedOptional("ops.workspaces.list", { offset: "0", limit: "20" }))
          : Promise.resolve(undefined),
        platformStoreScope ? authorizedOptional("ops.stores.list", { platform_scope: "platform" }) : Promise.resolve(undefined),
        platformStoreScope ? authorizedOptional("ops.brand-units.summary", { platform_scope: "platform" }) : Promise.resolve(undefined),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("canonical.product.consistency"),
        platformStoreScope ? authorizedOptional("ops.tasks.summary", { platform_scope: "platform" }) : Promise.resolve(undefined),
        platformStoreScope ? authorizedOptional("ops.marketing.summary", { platform_scope: "platform" }) : Promise.resolve(undefined),
        platformStoreScope ? authorizedOptional("ops.model-usage.summary", { platform_scope: "platform" }) : Promise.resolve(undefined),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("billing.model-usage.statement", { limit: "50" }),
        platformOperator ? authorizedOptional("ops.commercial.offers.list") : Promise.resolve(undefined),
        platformOperator ? authorizedOptional("ops.commercial.addons.list") : Promise.resolve(undefined),
        platformOperator ? authorizedOptional("ops.commercial.coupons.list") : Promise.resolve(undefined),
        platformOperator ? authorizedOptional("ops.commercial.rollouts.list") : Promise.resolve(undefined),
        platformOperator ? authorizedOptional("ops.growth.funnel", { platform_scope: "platform" }) : Promise.resolve(undefined),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("workspace.health"),
        platformOperator ? authorizedOptional("ops.alerts.list", alertListParams(activeAlertFilters, platformAlertScope)) : Promise.resolve(undefined),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("ops.data.delete.list", { limit: "50" }),
        !platformOperator && allowedHydrationMethods.has("platform.model.status") ? (async () => {
          try {
            const value = await scheduledRpc("platform.model.status");
            setModelStatus(value as unknown as ModelStatus);
            return value;
          } catch (cause) {
            firstOptionalError ??= cause;
            failedDataSets.push("platform.model.status");
            failedDataSetErrors["platform.model.status"] = describeOpsError(cause);
            return undefined;
          } finally {
            loadCoordinatorRef.current.commit(loadRequest, () => setModelStatusLoading(false));
          }
        })() : Promise.resolve(undefined).finally(() => loadCoordinatorRef.current.commit(loadRequest, () => setModelStatusLoading(false))),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("workspace.metrics"),
        platformOperator ? authorizedOptional("ops.storage.reconciliation.list", { platform_scope: "platform" }) : Promise.resolve(undefined),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("knowledge.rule.list"),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("knowledge.asset.list"),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("knowledge.learning.list", { status: "pending" }),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("knowledge.competitor.list"),
        !platformOperator && hasCustomerDataRole
          ? authorizedOptional("ops.marketing.queue", marketingQueueParams(activeQueueFilters))
          : Promise.resolve(undefined),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("automation.policy.get"),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("automation.policy.list"),
        platformOperator ? Promise.resolve(undefined) : authorizedOptional("automation.scan"),
      ]);
      if (!loadCoordinatorRef.current.isCurrent(loadRequest)) return;
      setDataSetErrors(failedDataSetErrors);
      setDataSetErrorEvidence(failedDataSetErrorEvidence);
      if (firstOptionalError) setError(`部分数据集刷新失败（${failedDataSets.join("、")}）。页面保留上次成功数据，这些值可能已过期：${describeOpsError(firstOptionalError)}`);
      applyLoadedValue(result, (value) => {
        setSettings(value?.settings);
        setPlatformRows(value?.platforms ?? []);
        setSubscription(value?.subscription);
        setOrders(value?.orders ?? []);
      });
      applyLoadedValue(auditResult, (value) => {
        const records = Array.isArray(value) ? value : (value as { records?: Array<Record<string, unknown>> } | undefined)?.records ?? [];
        setAudits(records.map((record) => ({ ...record, createdAt: String(record.createdAt ?? record.occurredAt ?? "") })) as unknown as Audit[]);
      });
      applyLoadedValue(membersResult, (value) => setMembers((value ?? []) as unknown as Member[]));
      applyLoadedValue(workspacesResult, (value) => {
        const page = Array.isArray(value) ? { items: value, total: value.length, offset: 0, limit: value.length || 20, hasMore: false } : value as unknown as WorkspaceDirectoryPage;
        setWorkspaceDirectory(page);
        setWorkspaceRows(page.items ?? []);
      });
      applyLoadedValue(storesResult, (value) => {
        const items = (value as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
        setStoreDirectory(items as unknown as StoreDirectory[]);
        if (platformOperator) {
          const platforms = [...new Set(items.map((item) => String(item.platform ?? "")).filter(Boolean))];
          setPlatformOperations(items as unknown as PlatformOperation[]);
          setPlatformHealth(Object.fromEntries(platforms.map((platform) => [platform, {
            ready: items.some((item) => item.platform === platform && item.readable === true),
            reasons: items.some((item) => item.platform === platform && item.readable === true) ? [] : ["平台店铺暂无可读取连接"],
          }])) as Record<string, PlatformHealth>);
        }
      });
      applyLoadedValue(taskSummaryResult, (value) => setPlatformTaskSummary(value as unknown as PlatformTaskSummary));
      applyLoadedValue(brandUnitSummaryResult, (value) => setPlatformBrandUnitSummary(value as unknown as PlatformBrandUnitSummary));
      applyLoadedValue(canonicalProductConsistencyResult, (value) => setCanonicalProductConsistency(value as unknown as CanonicalProductConsistencyReport));
      applyLoadedValue(marketingSummaryResult, (value) => setPlatformMarketingSummary(value as unknown as PlatformMarketingSummary));
      if (platformOperator && taskSummaryResult && typeof taskSummaryResult === "object") {
        const tasks = taskSummaryResult as unknown as PlatformTaskSummary;
        const marketing = marketingSummaryResult as unknown as PlatformMarketingSummary | undefined;
        setWorkspaceMetrics({ jobs: {
          sync: 0,
          generation: tasks.generationQueueCount,
          generationFailed: marketing?.generationByState?.failed ?? 0,
          publish: tasks.publishQueueCount,
        } });
      }
      applyLoadedValue(modelUsageSummaryResult, (value) => setPlatformModelUsageSummary(value as unknown as PlatformModelUsageSummary));
      applyLoadedValue(financeResult, (value) => setReconciliation(value as unknown as Reconciliation));
      applyLoadedValue(offerResult, (value) => setOffers((value ?? []) as unknown as Offer[]));
      applyLoadedValue(addonResult, (value) => setAddons((value ?? []) as unknown as Addon[]));
      applyLoadedValue(couponResult, (value) => setCoupons((value ?? []) as unknown as Coupon[]));
      applyLoadedValue(rolloutResult, (value) => setRollouts((value ?? []) as unknown as Rollout[]));
      applyLoadedValue(funnelResult, (value) => setFunnel(value as unknown as GrowthFunnel));
      applyLoadedValue(metricsResult, (value) => setWorkspaceMetrics(value as unknown as WorkspaceMetrics));
      applyLoadedValue(storageReconciliationResult, (value) => setStorageReconciliationWorkspaces(((value ?? []) as Array<Record<string, unknown>>).map(item => ({ ...item, workspaceId: item.workspaceId ?? item.workspace_id })) as unknown as NonNullable<WorkspaceMetrics["storageReconciliation"]>[]));
      applyLoadedValue(assetResult, (value) => setKnowledgeAssets((value ?? []) as unknown as KnowledgeAsset[]));
      applyLoadedValue(learningResult, (value) => setLearningSuggestions((value ?? []) as unknown as LearningSuggestion[]));
      applyLoadedValue(competitorResult, (value) => setCompetitors((value ?? []) as unknown as CompetitorAnalysis[]));
      applyLoadedValue(knowledgeRuleResult, (value) => setKnowledgeRules((value ?? []) as unknown as Rule[]));
      if (queueResult && typeof queueResult === "object")
        setMarketingQueue({
          generation: [],
          publish: [],
          visuals: [],
          batches: [],
          learningSuggestions: [],
          assetRisks: [],
          uploadedAssetRisks: [],
          imageExecutions: [],
          ...(queueResult as unknown as Partial<MarketingQueue>),
        });
      if (
        automationResult &&
        typeof automationResult === "object" &&
        !Array.isArray(automationResult)
      )
        setAutomationPolicy(automationResult.policy as AutomationPolicy);
      if (
        automationListResult &&
        typeof automationListResult === "object" &&
        !Array.isArray(automationListResult)
      )
        setAutomationPolicies(
          (automationListResult.policies ?? []) as AutomationPolicy[],
        );
      if (
        automationScanResult &&
        typeof automationScanResult === "object" &&
        !Array.isArray(automationScanResult)
      )
        setAutomationScan(automationScanResult as AutomationScan);
      if (
        sessionResult &&
        typeof sessionResult === "object" &&
        !Array.isArray(sessionResult)
      ) {
        const nextSession = sessionResult as unknown as OpsSession;
        opsSessionRef.current = nextSession;
        setOpsSession(nextSession);
      }
      const health = healthResult as unknown as {
        environment?: string;
        persistence?: { mode?: string };
        plugin?: { name?: string };
        connectorReadiness?: Record<string, PlatformHealth>;
        platforms?: PlatformOperation[];
        storeDirectory?: StoreDirectory[];
        capabilityCards?: { brandNavigation?: { items?: BrandNavigationItem[] } };
        setup?: {
          dataLifecycle?: DataLifecycle;
          productionEvidence?: {
            capability: EvidenceReadiness;
            capacity: EvidenceReadiness;
          };
        };
      };
      const metrics = metricsResult as unknown as {
        dataCoverage?: { fixtureDataPresent?: boolean };
      } | undefined;
      const stores = health?.storeDirectory ?? [];
      if (healthResult !== undefined) {
        setDataSource({
          environment: health?.environment,
          persistence: health?.persistence?.mode,
          plugin: health?.plugin?.name,
          fixtureDataPresent: metrics?.dataCoverage?.fixtureDataPresent === true || stores.some((store) => store.dataMode === "fixture"),
          officialStoreCount: stores.filter((store) => store.dataMode === "official_api").length,
          fixtureStoreCount: stores.filter((store) => store.dataMode === "fixture").length,
        });
        setPlatformHealth((health?.connectorReadiness ?? {}) as Record<string, PlatformHealth>);
        setPlatformOperations(health?.platforms ?? []);
        setStoreDirectory(health?.storeDirectory ?? []);
        setBrandNavigation(health?.capabilityCards?.brandNavigation?.items ?? []);
        setDataLifecycle(health?.setup?.dataLifecycle ?? { state: "not_required" });
        setProductionEvidence(health?.setup?.productionEvidence ?? { capability: { state: "not_required" }, capacity: { state: "not_required" } });
      }
      applyLoadedValue(alertResult, (value) => {
        const rows = Array.isArray(value) ? value : (value as { items?: unknown[] } | undefined)?.items ?? [];
        setAlerts(rows as unknown as OperationalAlert[]);
      });
      applyLoadedValue(deletionResult, (value) => {
        const rows = Array.isArray(value) ? value : (value as { items?: unknown[] } | undefined)?.items ?? [];
        setDeletionRequests(rows as unknown as DataDeletionRequest[]);
      });
      applyLoadedValue(modelResult, (value) => setModelStatus(value as unknown as ModelStatus));
    } catch (cause) {
      loadCoordinatorRef.current.commit(loadRequest, () => {
        const message = describeOpsError(cause);
        setDataSetErrors({ "*": message });
        setError(message);
      });
    } finally {
      loadInFlightKeysRef.current.delete(loadKey);
      loadCoordinatorRef.current.commit(loadRequest, () => setLoading(false));
    }
  };
  const loadRules = async () => {
    if (!hasOpsConnection()) return;
    setRuleSyncLoading(true);
    const [rulesResult, syncResult] = await Promise.allSettled([
      rpc("rule.list"),
      rpc("rule.sync.status"),
    ]);
    setDataSetErrors(previous => {
      const next = { ...previous };
      if (rulesResult.status === "fulfilled") delete next["rule.list"];
      else next["rule.list"] = describeOpsError(rulesResult.reason);
      if (syncResult.status === "fulfilled") delete next["rule.sync.status"];
      else next["rule.sync.status"] = describeOpsError(syncResult.reason);
      return next;
    });
    if (rulesResult.status === "fulfilled") setRules((rulesResult.value ?? []) as unknown as Rule[]);
    else message.error(`规则列表加载失败：${describeOpsError(rulesResult.reason)}`);
    if (syncResult.status === "fulfilled") setRuleSyncStatuses((syncResult.value ?? []) as unknown as RuleSyncStatus[]);
    else message.error(`规则同步状态加载失败：${describeOpsError(syncResult.reason)}`);
    if (rulesResult.status === "rejected" || syncResult.status === "rejected") setError("规则数据加载失败，请重试；空列表不代表没有平台规则。");
    else setError("");
    setRuleSyncLoading(false);
  };
  const opsRoleKey = opsSession?.roles.join("|") ?? "";
  useEffect(() => {
    if (!hasOpsConnection()) {
      setLoading(false);
      setModelStatusLoading(false);
      return;
    }
    void load();
  }, [managedOpsSession, opsRoleKey]);
  useEffect(() => () => cancelUserRequests(), []);
  const enabledCount = useMemo(
    () => platformRows.filter((row) => row.enabled).length,
    [platformRows],
  );
  const authorization = useMemo(
    () => createAuthorizationProjection(opsSession, managedOpsSession),
    [opsSession],
  );
  const opsWorkspaceId = opsSession?.workspace_id ?? (
    (managedOpsSession ? sessionStorage : localStorage).getItem("ops_workspace_id")?.trim() ?? ""
  );
  const financeAccess = financePermissions(authorization);
  const can = (capabilities: readonly string[]) => authorization.canAny(capabilities);
  const canFinance = financeAccess.refund;
  const canPaymentReconciliation = financeAccess.paymentReconciliation;
  const canModelSettlement = financeAccess.modelSettlement;
  const canBillingExport = financeAccess.billingExport;
  const canAuditExport = authorization.can("audit.export");
  // Compatibility presentation flag for sections not yet split into granular
  // controls. Every mutation below still checks its exact capability.
  const canPlatformOps = authorization.canAny([
    "workspace.settings.update", "store.connection.update", "platform.settings.update", "commercial.update",
  ]);
  const canWriteFeatureFlags = authorization.can("feature_flag.update");
  const canEmergencyFeatureFlags = authorization.can("feature_flag.administer");
  const canGlobalCommercial = authorization.can("commercial.update");
  const canUserGovernance = authorization.can("identity.update");
  const canModelMarkup = authorization.canAny(["commercial.read", "commercial.update"]);
  const canKnowledge = authorization.can("customer.content.update");
  const canCompetitor = authorization.can("customer.content.update");
  const canRules = authorization.canAny(["rule.update", "rule.publish.approve"]);
  const canQueue = authorization.can("marketing.queue.update");
  const canMembers = authorization.can("workspace.member.manage");
  const dataSetError = (...methods: string[]) => dataSetErrorFor(dataSetErrors, methods);
  const dataSetErrorEvidence = (...methods: string[]) => dataSetErrorEvidenceFor(dataSetErrorEvidenceByMethod, methods);
  useEffect(() => {
    if (canModelMarkup) return;
    setModelMarkup(undefined);
    setModelMarkupReason("");
  }, [canModelMarkup]);
  const selectedAutomationStore = storeDirectory.find(
    (row) => `${row.platform}:${row.accountId}` === automationScope,
  );
  const automationScopeParams = (): Record<string, string> =>
    selectedAutomationStore
      ? {
          platform: selectedAutomationStore.platform,
          account_id: selectedAutomationStore.accountId,
        }
      : {};

  const updateRuleStatus = async (
    row: Rule,
    status: "active" | "inactive" | "expired",
    options?: { reason?: string; approvalRef?: string; approvedBy?: string; approvedAt?: string },
  ) => {
    if (!canRules) {
      message.error("当前会话为只读，缺少规则管理员权限");
      return false;
    }
    if (ruleMutationInFlight.current) return false;
    ruleMutationInFlight.current = true;
    setRuleMutationKey(`${row.id}:${status}`);
    try {
      await rpc("rule.status", {
        pack_id: row.packId,
        version: row.version,
        status,
        reason: options?.reason?.trim() || "运营后台规则生命周期调整",
        ...(status === "active" ? { approval_json: JSON.stringify({
          approval_ref: options?.approvalRef?.trim(),
          approved_by: options?.approvedBy?.trim(),
          approved_at: options?.approvedAt,
        }) } : {}),
      });
      message.success("规则状态已更新");
      await loadRules();
      return true;
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "规则状态更新失败",
      );
      return false;
    } finally {
      ruleMutationInFlight.current = false;
      setRuleMutationKey(undefined);
    }
  };
  const publishRuleDraft = async (values: {
    packId: string;
    name: string;
    version: string;
    sourceReference: string;
    checksJson: string;
    reason: string;
  }) => {
    if (!canRules) {
      message.error("当前会话为只读，缺少规则管理员权限");
      return;
    }
    if (ruleMutationInFlight.current) return;
    ruleMutationInFlight.current = true;
    setRuleMutationKey("draft");
    try {
      await rpc("rule.publish", {
        pack_id: values.packId,
        name: values.name,
        version: values.version,
        scope: "global",
        source_kind: "official",
        source_reference: values.sourceReference,
        source_checked_at: new Date().toISOString(),
        checks_json: values.checksJson,
        reason: values.reason,
        status: "draft",
      });
      message.success("规则草稿已创建，激活需要规则管理员审批");
      ruleForm.resetFields();
      await loadRules();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "规则发布失败");
    } finally {
      ruleMutationInFlight.current = false;
      setRuleMutationKey(undefined);
    }
  };

  const saveCommercial = async (values: Omit<Settings, "revision">) => {
    if (!authorization.can("workspace.settings.update")) {
      message.error("当前会话为只读，缺少商业配置权限");
      return;
    }
    if (!settings) return;
    setSaving(true);
    try {
      const result = await rpc("workspace.commercial.update", {
        plan_code: values.planCode,
        plan_name: values.planName,
        monthly_price_cny: values.monthlyPriceCny.toFixed(2),
        annual_price_cny: values.annualPriceCny.toFixed(2),
        included_stores: String(values.includedStores),
        included_tasks: String(values.includedTasks),
        expected_revision: String(settings.revision),
      });
      setSettings(result as Settings);
      message.success("商业配置已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "保存失败");
      await load();
    } finally {
      setSaving(false);
    }
  };
  const savePlatform = async (row: PlatformSetting) => {
    if (!authorization.can("platform.settings.update")) {
      message.error("当前会话为只读，缺少平台配置权限");
      return;
    }
    try {
      const result = await rpc("platform.settings.update", {
        platform: row.platform,
        enabled: String(row.enabled),
        display_name: row.displayName,
        store_alias: row.storeAlias,
        expected_revision: String(row.revision),
        reason: row.changeReason?.trim() || "运营后台平台配置调整",
      });
      setPlatformRows((current) =>
        current.map((item) =>
          item.platform === row.platform
            ? { ...(result as PlatformSetting), changeReason: row.changeReason }
            : item,
        ),
      );
      message.success(`${row.displayName || row.platform} 配置已保存`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "保存失败");
      await load();
    }
  };
  const saveStoreAlias = async (row: StoreDirectory, alias: string) => {
    if (!authorization.can("store.connection.update")) {
      message.error("当前会话为只读，缺少平台运营权限");
      return false;
    }
    const normalizedAlias = alias.trim();
    if (!normalizedAlias || normalizedAlias === row.alias) return false;
    try {
      await rpc("platform.store.alias.set", {
        platform: row.platform,
        account_id: row.accountId,
        alias: normalizedAlias,
        expected_revision: String(row.revision),
      });
      message.success("店铺别名已保存");
      await load();
      return true;
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "店铺别名保存失败",
      );
      return false;
    }
  };
  const createBrand = async (name: string) => {
    if (!authorization.can("customer.content.update")) {
      message.error("当前会话无权创建品牌");
      return false;
    }
    try {
      await rpc("brand-unit.create", { name: name.trim() });
      message.success("品牌已创建");
      await load();
      return true;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "创建品牌失败");
      return false;
    }
  };
  const revokeStore = async (row: StoreDirectory) => {
    if (!authorization.can("store.connection.update")) {
      message.error("当前会话为只读，缺少平台运营权限");
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      modal.confirm({
        title: `确认撤销 ${row.label} 的本地授权状态？`,
        content: "撤销后不会再执行同步或发布，可重新完成官方授权后恢复。",
        okText: "确认撤销",
        cancelText: "取消",
        okButtonProps: { danger: true },
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      await rpc("platform.revoke", {
        platform: row.platform,
        account_id: row.accountId,
      });
      message.success("店铺授权已撤销");
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "店铺授权撤销失败",
      );
    }
  };
  const saveMember = async (values: {
    externalSubject: string;
    displayName?: string;
    role: string;
  }) => {
    if (!canMembers) {
      message.error("当前会话为只读，缺少成员管理权限");
      return;
    }
    try {
      await rpc("ops.member.upsert", {
        external_subject: values.externalSubject,
        display_name: values.displayName ?? "",
        role: values.role,
        reason: "运营后台成员角色调整",
      });
      message.success("成员角色已保存");
      memberForm.resetFields();
      await load();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "成员保存失败");
    }
  };
  const loadUsers = async (filters: { query?: string; status?: string; workspaceId?: string; page?: number; pageSize?: number } = userDirectoryFilters) => {
    if (!hasOpsConnection()) return false;
    const requestKey = JSON.stringify(filters);
    if (userDirectoryInFlightKeysRef.current.has(requestKey)) return false;
    const controller = userRequestsRef.current.beginDirectory();
    userDirectoryInFlightKeysRef.current.add(requestKey);
    const requestId = ++userDirectoryRequestRef.current;
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 20;
    setUserDirectoryFilters(filters);
    setUserDirectoryLoading(true);
    setUserDirectoryError("");
    try {
      const response = await rpc("ops.users.list", {
        limit: String(pageSize),
        offset: String((page - 1) * pageSize),
        ...(filters.query?.trim() ? { query: filters.query.trim() } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.workspaceId?.trim() ? { workspace_id: filters.workspaceId.trim() } : {}),
      }, { signal: controller.signal });
      if (requestId === userDirectoryRequestRef.current) setUserDirectory(response as unknown as PlatformUserDirectory);
    } catch (cause) {
      if (!controller.signal.aborted && requestId === userDirectoryRequestRef.current) setUserDirectoryError(describeOpsError(cause));
    } finally {
      userDirectoryInFlightKeysRef.current.delete(requestKey);
      if (requestId === userDirectoryRequestRef.current) {
        userRequestsRef.current.finishDirectory(controller);
        setUserDirectoryLoading(false);
      }
    }
  };
  const loadWorkspaceDirectory = async (filters: { query?: string; status?: "active" | "disabled"; subscriptionStatus?: string; page?: number; pageSize?: number } = {}) => {
    if (!hasOpsConnection() || !authorization.can("workspace.directory.read")) return false;
    const requestId = ++workspaceDirectoryRequestRef.current;
    const page = filters.page ?? Math.floor(workspaceDirectory.offset / workspaceDirectory.limit) + 1;
    const pageSize = filters.pageSize ?? workspaceDirectory.limit;
    setWorkspaceDirectoryLoading(true);
    try {
      const value = await rpc("ops.workspaces.list", {
        offset: String((page - 1) * pageSize),
        limit: String(pageSize),
        ...(filters.query?.trim() ? { query: filters.query.trim() } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.subscriptionStatus?.trim() ? { subscription_status: filters.subscriptionStatus.trim() } : {}),
      });
      if (requestId !== workspaceDirectoryRequestRef.current) return false;
      const next = value as unknown as WorkspaceDirectoryPage;
      setWorkspaceDirectory(next);
      setWorkspaceRows(next.items ?? []);
      return true;
    } catch (cause) {
      if (requestId === workspaceDirectoryRequestRef.current) message.error(describeOpsError(cause));
      return false;
    } finally {
      if (requestId === workspaceDirectoryRequestRef.current) setWorkspaceDirectoryLoading(false);
    }
  };
  const exportUsers = async (filters: { query?: string; status?: string; workspaceId?: string } = {}) => {
    if (!canUserGovernance) {
      message.error("当前会话为只读，缺少平台用户导出权限");
      return false;
    }
    const controller = userRequestsRef.current.beginExport();
    if (!controller) return false;
    setUserExporting(true);
    try {
      const result = (await rpc("ops.users.export", {
        format: "csv",
        limit: "5000",
        ...(filters.query?.trim() ? { query: filters.query.trim() } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.workspaceId?.trim() ? { workspace_id: filters.workspaceId.trim() } : {}),
      }, { signal: controller.signal, timeoutMs: 30_000, maxResponseBytes: 16 * 1024 * 1024 })) as unknown as { filename: string; content: string; truncated?: boolean };
      const blob = new Blob([result.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      message.success(result.truncated ? "已导出前 5000 条用户成员关系，请继续缩小筛选范围" : "用户目录已导出");
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) message.error(describeOpsError(cause));
      return false;
    } finally {
      if (userRequestsRef.current.finishExport(controller)) setUserExporting(false);
    }
  };
  const exportCommercial = async () => {
    if (!canGlobalCommercial) {
      message.error("当前会话为只读，缺少商业配置导出权限");
      return false;
    }
    try {
      const result = (await rpc("ops.commercial.export", { format: "csv" })) as unknown as { filename: string; content: string };
      const blob = new Blob([result.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      message.success("商业配置已导出，不包含支付密钥");
      return true;
    } catch (cause) {
      message.error(describeOpsError(cause));
      return false;
    }
  };
  const suspendUsers = async (targets: Array<{ workspaceId: string; externalSubject: string; revision?: number }>, reason: string) => {
    if (!canUserGovernance) {
      message.error("当前会话为只读，缺少平台用户治理权限");
      return { succeeded: 0, failed: targets.length };
    }
    let succeeded = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        if (target.revision === undefined) throw new Error("用户成员版本已过期，请刷新后重试");
        await rpc("ops.user.suspend", { workspace_id: target.workspaceId, external_subject: target.externalSubject, expected_revision: String(target.revision), reason });
        succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    await loadUsers(userDirectoryFilters);
    if (failed) message.warning(`已停用 ${succeeded} 个成员，${failed} 个失败，请查看刷新后的状态并单独处理`);
    else message.success(`已停用 ${succeeded} 个成员`);
    return { succeeded, failed };
  };
  const suspendUser = async (workspaceId: string, externalSubject: string, reason: string) => {
    if (!canUserGovernance) {
      message.error("当前会话为只读，缺少平台用户治理权限");
      return false;
    }
    try {
      await rpc("ops.user.suspend", {
        workspace_id: workspaceId,
        external_subject: externalSubject,
        expected_revision: String((userDirectory.items.find((item) => item.workspaceId === workspaceId && item.externalSubject === externalSubject)?.revision) ?? 0),
        reason,
      });
      message.success("用户在该工作区的访问已停用");
      await loadUsers(userDirectoryFilters);
      if (userDetail?.identity.externalSubject === externalSubject) await loadUserDetail(externalSubject);
      return true;
    } catch (cause) {
      message.error(describeOpsError(cause));
      return false;
    }
  };
  const activateUser = async (workspaceId: string, externalSubject: string, reason: string) => {
    if (!canUserGovernance) {
      message.error("当前会话为只读，缺少平台用户治理权限");
      return false;
    }
    try {
      await rpc("ops.user.activate", {
        workspace_id: workspaceId,
        external_subject: externalSubject,
        expected_revision: String((userDirectory.items.find((item) => item.workspaceId === workspaceId && item.externalSubject === externalSubject)?.revision) ?? 0),
        reason,
      });
      message.success("用户在该工作区的访问已恢复");
      await loadUsers(userDirectoryFilters);
      if (userDetail?.identity.externalSubject === externalSubject) await loadUserDetail(externalSubject);
      return true;
    } catch (cause) {
      message.error(describeOpsError(cause));
      return false;
    }
  };
  const changeIdentityAccess = async (target: "active" | "suspended", reason: string) => {
    const identity = userDetail?.identity;
    if (!canUserGovernance || !identity?.id || !identity.revision) { message.error("当前详情没有可治理的持久平台身份"); return false; }
    const identityId = identity.id;
    const operation = JSON.stringify(["identity-access", identityId, identity.revision, target, reason]);
    try {
      await runIdempotentOperation(identityOperationKeysRef.current, operation, (idempotencyKey) =>
        rpc(target === "suspended" ? "ops.user.suspend" : "ops.user.activate", { scope: "identity", identity_id: identityId, expected_revision: String(identity.revision), idempotency_key: idempotencyKey, reason }),
      );
      message.success(target === "suspended" ? "平台身份已全局停用，活动会话已撤销" : "平台身份已恢复；旧会话不会自动复活");
      await loadUserDetail(identity.externalSubject, identityId);
      return true;
    } catch (cause) { message.error(describeOpsError(cause)); return false; }
  };
  const transitionIdentityRisk = async (level: "low" | "medium" | "high" | "critical", decision: "allow" | "step_up" | "block", reason: string) => {
    const identity = userDetail?.identity;
    if (!canUserGovernance || !identity?.id || !identity.revision) { message.error("当前详情没有可治理的持久平台身份"); return false; }
    const identityId = identity.id;
    const operation = JSON.stringify(["identity-risk", identityId, identity.revision, level, decision, reason]);
    try {
      await runIdempotentOperation(identityOperationKeysRef.current, operation, (idempotencyKey) =>
        rpc("ops.user.risk.transition", { identity_id: identityId, risk_level: level, risk_decision: decision, expected_revision: String(identity.revision), idempotency_key: idempotencyKey, reason, evidence_json: JSON.stringify({ source: "ops_console" }) }),
      );
      message.success(decision === "block" ? "身份已阻断，活动会话已撤销" : "身份风险策略已更新");
      await loadUserDetail(identity.externalSubject, identityId);
      return true;
    } catch (cause) { message.error(describeOpsError(cause)); return false; }
  };
  const revokeIdentitySession = async (sessionId: string, expectedRevision: number, reason: string) => {
    const identity = userDetail?.identity;
    if (!canUserGovernance || !identity?.id) { message.error("当前详情没有可治理的持久平台身份"); return false; }
    const identityId = identity.id;
    const operation = JSON.stringify(["identity-session-revoke", identityId, sessionId, expectedRevision, reason]);
    try {
      await runIdempotentOperation(identityOperationKeysRef.current, operation, (idempotencyKey) =>
        rpc("ops.user.session.revoke", { identity_id: identityId, session_id: sessionId, expected_revision: String(expectedRevision), idempotency_key: idempotencyKey, reason }),
      );
      message.success("会话已撤销");
      await loadUserDetail(identity.externalSubject, identityId);
      return true;
    } catch (cause) { message.error(describeOpsError(cause)); return false; }
  };
  const changeWorkspaceStatus = async (targetWorkspaceId: string, target: "active" | "disabled", reason: string) => {
    if (!canUserGovernance) { message.error("当前会话缺少跨租户治理权限"); return false; }
    try {
      await rpcForWorkspace(targetWorkspaceId, target === "disabled" ? "workspace.deactivate" : "workspace.activate", { reason: reason.trim() });
      message.success(target === "disabled" ? "租户已停用，业务数据仍保留" : "租户已恢复");
      await load();
      return true;
    } catch (cause) { message.error(describeOpsError(cause)); return false; }
  };
  const loadUserDetail = async (externalSubject: string, identityId?: string) => {
    if (!hasOpsConnection()) return false;
    if (!canUserGovernance) {
      message.error("当前会话缺少平台用户治理权限");
      return false;
    }
    const controller = userRequestsRef.current.beginDetail();
    const requestId = ++userDetailRequestRef.current;
    setUserDetail(undefined);
    setUserDetailLoading(true);
    try {
      const response = await rpc("ops.user.detail", identityId ? { identity_id: identityId } : { external_subject: externalSubject }, { signal: controller.signal });
      if (requestId === userDetailRequestRef.current) setUserDetail(response as unknown as PlatformUserDetail);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && requestId === userDetailRequestRef.current) {
        setUserDetail(undefined);
        message.error(describeOpsError(cause));
      }
      return false;
    } finally {
      if (requestId === userDetailRequestRef.current) {
        userRequestsRef.current.finishDetail(controller);
        setUserDetailLoading(false);
      }
    }
  };
  const refund = async (values: { orderId: string; reason: string }) => {
    if (!canPaymentReconciliation) {
      message.error("当前会话为只读，缺少账务权限");
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      modal.confirm({
        title: `确认对订单 ${values.orderId} 创建退款？`,
        content: `原因：${values.reason}。退款会产生真实账务流水，提交后不能通过此页面撤销。`,
        okText: "确认退款",
        cancelText: "取消",
        okButtonProps: { danger: true },
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;
    setRefundSubmitting(true);
    try {
      await rpc("billing.refund", {
        order_id: values.orderId,
        reason: values.reason,
      });
      message.success("退款流水已创建");
      refundForm.resetFields();
      await load();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "退款失败");
    } finally {
      setRefundSubmitting(false);
    }
  };
  const runReconciliation = async () => {
    if (!canModelSettlement) {
      message.error("当前会话为只读，缺少账务权限");
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      modal.confirm({
        title: "确认查询支付服务商的待支付订单？",
        content: "已确认支付的订单会幂等入账，金额或交易号异常只会进入失败列表。",
        okText: "确认查单",
        cancelText: "取消",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      const report = (await rpc("billing.reconciliation.run", {
        limit: "50",
      })) as unknown as {
        settled?: Array<unknown>;
        pending?: Array<unknown>;
        failed?: Array<unknown>;
      };
      message.success(
        `对账完成：入账 ${report.settled?.length ?? 0}，待处理 ${report.pending?.length ?? 0}，异常 ${report.failed?.length ?? 0}`,
      );
      await load();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "支付对账失败");
    }
  };
  const loadRechargeOrders = async (state = rechargeOrderStateFilter) => {
    if (!hasOpsConnection()) return false;
    const requestId = ++rechargeOrdersRequestRef.current;
    setRechargeOrderStateFilter(state);
    setRechargeOrdersLoading(true);
    setRechargeOrdersError("");
    try {
      const result = await rpc("billing.recharge.list", rechargeOrderListParams(state));
      if (requestId === rechargeOrdersRequestRef.current)
        setRechargeOrders(result as unknown as RechargeOrderList);
      return true;
    } catch (cause) {
      if (requestId === rechargeOrdersRequestRef.current) {
        setRechargeOrdersError(describeOpsError(cause));
        setRechargeOrders({ orders: [] });
      }
      return false;
    } finally {
      if (requestId === rechargeOrdersRequestRef.current)
        setRechargeOrdersLoading(false);
    }
  };
  const queryRechargeOrder = async (orderId: string) => {
    if (!canPaymentReconciliation) {
      message.error("当前会话缺少支付查单权限");
      return false;
    }
    setQueryingRechargeOrderId(orderId);
    try {
      await rpc("billing.recharge.get", { order_id: orderId });
      message.success("订单状态已更新");
      await loadRechargeOrders(rechargeOrderStateFilter);
      return true;
    } catch (cause) {
      message.error(describeOpsError(cause));
      return false;
    } finally {
      setQueryingRechargeOrderId(undefined);
    }
  };
  const runModelUsageReconciliation = async () => {
    try {
      return await runAuthorizedFinanceAction(
        canModelSettlement,
        async () => {
          const report = (await rpc("billing.model-usage.reconciliation.run", { limit: "50" })) as unknown as { settled?: string[]; pending?: Array<unknown> };
          message.success(`模型结算完成：成功 ${report.settled?.length ?? 0}，仍待处理 ${report.pending?.length ?? 0}`);
          await load();
        },
        () => message.error("当前会话为只读，缺少模型结算权限"),
      );
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "模型用量对账失败");
      return false;
    }
  };
  const retryModelUsageSettlement = async (record: ModelUsageSettlementRecord, reason: string, evidenceRef: string) => {
    if (!canModelSettlement || record.revision === undefined) throw new Error(record.revision === undefined ? "缺少记录 revision，请刷新后重试" : "当前会话缺少模型结算权限");
    await rpc("billing.model-usage.resolve", { usage_id: record.id, revision: String(record.revision), decision: "retry", reason, evidence_ref: evidenceRef });
    await load();
  };
  const waiveModelUsageSettlement = async (record: ModelUsageSettlementRecord, reason: string, evidenceRef: string) => {
    if (!canModelSettlement || record.revision === undefined) throw new Error(record.revision === undefined ? "缺少记录 revision，请刷新后重试" : "当前会话缺少模型结算权限");
    await rpc("billing.model-usage.resolve", { usage_id: record.id, revision: String(record.revision), decision: "waive", reason, evidence_ref: evidenceRef });
    await load();
  };
  const markModelUsageForManualAttention = async (record: ModelUsageSettlementRecord, reason: string, evidenceRef: string) => {
    if (!canModelSettlement || record.revision === undefined) throw new Error(record.revision === undefined ? "缺少记录 revision，请刷新后重试" : "当前会话缺少模型结算权限");
    await rpc("billing.model-usage.resolve", { usage_id: record.id, revision: String(record.revision), decision: "manual_attention", reason, evidence_ref: evidenceRef });
    await load();
  };
  const exportBilling = async () => {
    try {
      return await runAuthorizedFinanceAction(
        canBillingExport,
        async () => {
          const result = (await rpc("billing.export", {
            format: "csv",
            limit: "1000",
          })) as unknown as { filename: string; content: string };
          const blob = new Blob([result.content], {
            type: "text/csv;charset=utf-8",
          });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = result.filename;
          anchor.click();
          URL.revokeObjectURL(url);
          message.success("账单已导出");
        },
        () => message.error("当前会话为只读，缺少账单导出权限"),
      );
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "账单导出失败");
      return false;
    }
  };
  const exportOperations = async () => {
    try {
      const result = (await rpc("ops.audit.export", {
        format: "csv",
        limit: "5000",
      })) as unknown as { filename: string; content: string };
      const blob = new Blob([result.content], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      message.success("运营审计已导出");
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "运营审计导出失败",
      );
    }
  };
  const acknowledgeAlert = async (alert: OperationalAlert) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少告警处理权限");
      return;
    }
    try {
      await rpc("ops.alert.ack", {
        alert_id: alert.id,
        reason: "运营台已确认，转入人工处理",
      });
      setAlerts((current) => current.filter((item) => item.id !== alert.id));
      message.success("告警已确认");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "告警确认失败");
    }
  };
  const confirmLearning = async (suggestion: LearningSuggestion) => {
    if (!canKnowledge) {
      message.error("当前会话为只读，缺少知识治理权限");
      return;
    }
    try {
      const result = await rpc("knowledge.learning.confirm", {
        suggestion_id: suggestion.id,
        note: "运营台确认证据，未自动激活全局规则",
      });
      setLearningSuggestions((current) =>
        current.filter((item) => item.id !== suggestion.id),
      );
      message.success(
        `建议已确认：${(result as LearningSuggestion)?.id ?? suggestion.id}；仍需规则管理员单独发布`,
      );
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "学习建议确认失败",
      );
    }
  };
  const createKnowledgeRule = async (values: {
    name: string;
    content: string;
    scope: string;
    scopeValue?: string;
    sourceReference: string;
    sourceCheckedAt: string;
    version: string;
    status: string;
  }) => {
    if (!canRules) {
      message.error("当前会话为只读，缺少规则管理员权限");
      return;
    }
    try {
      await rpc("knowledge.rule.create", {
        name: values.name,
        content: values.content,
        scope: values.scope,
        ...(values.scopeValue ? { scope_value: values.scopeValue } : {}),
        source_kind: "official",
        source_reference: values.sourceReference,
        source_checked_at: values.sourceCheckedAt,
        version: values.version,
        status: values.status,
      });
      message.success("知识规则已录入");
      knowledgeRuleForm.resetFields();
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "知识规则录入失败",
      );
    }
  };
  const createKnowledgeAsset = async (values: {
    kind: "brand" | "customer";
    name: string;
    contentJson: string;
    source?: string;
  }) => {
    if (!canKnowledge) {
      message.error("当前会话为只读，缺少知识治理权限");
      return;
    }
    try {
      JSON.parse(values.contentJson);
      await rpc("knowledge.asset.create", {
        kind: values.kind,
        name: values.name,
        content_json: values.contentJson,
        ...(values.source ? { source: values.source } : {}),
      });
      message.success("知识资产已录入，等待审批和权益确认");
      knowledgeAssetForm.resetFields();
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "知识资产录入失败",
      );
    }
  };
  const updateKnowledgeAsset = async (
    asset: KnowledgeAsset,
    patch: {
      approvalStatus?: KnowledgeAsset["approvalStatus"];
      rightsStatus?: KnowledgeAsset["rightsStatus"];
    },
  ) => {
    if (!canKnowledge) {
      message.error("当前会话为只读，缺少知识治理权限");
      return;
    }
    try {
      await rpc("knowledge.asset.update", {
        asset_id: asset.id,
        ...(patch.approvalStatus
          ? { approval_status: patch.approvalStatus }
          : {}),
        ...(patch.rightsStatus ? { rights_status: patch.rightsStatus } : {}),
      });
      message.success("知识资产治理状态已更新");
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "知识资产状态更新失败",
      );
    }
  };
  const dismissLearning = async (suggestion: LearningSuggestion, note: string) => {
    if (!canKnowledge) {
      message.error("当前会话为只读，缺少知识治理权限");
      return false;
    }
    const normalizedNote = note.trim();
    if (!normalizedNote) return false;
    try {
      await rpc("knowledge.learning.dismiss", {
        suggestion_id: suggestion.id,
        note: normalizedNote,
      });
      message.success("学习建议已驳回");
      await load();
      return true;
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "学习建议驳回失败",
      );
      return false;
    }
  };
  const governUploadedAsset = async (asset: UploadedAssetRisk, input: { rightsStatus?: string; rightsScope?: string; factsJson?: string; reason?: string } = {}) => {
    if (!canKnowledge) {
      message.error("当前会话为只读，缺少素材治理权限");
      return false;
    }
    const method = asset.nextAction?.method;
    if (!method) {
      message.info(asset.nextStep ?? "该素材当前没有可执行的运营动作");
      return false;
    }
    try {
      if (method === "asset.scan") {
        message.info("安全扫描由平台自动执行，运营后台无需也不能提交扫描凭据");
        return false;
      } else if (method === "asset.rights.update") {
        const rightsStatus = input.rightsStatus?.trim();
        if (
          !rightsStatus ||
          !["approved", "rejected", "pending"].includes(rightsStatus)
        ) return false;
        const rightsScope = input.rightsScope?.trim();
        if (!rightsScope || !["owned", "commercial_authorized", "limited_use", "internal_only", "unknown", "unusable"].includes(rightsScope)) return false;
        await rpc(method, {
          asset_id: asset.id,
          rights_status: rightsStatus,
          rights_scope: rightsScope,
        });
      } else if (method === "asset.facts.confirm") {
        const facts = input.factsJson?.trim();
        const reason = input.reason?.trim();
        if (!facts || !reason) return false;
        try { JSON.parse(facts); } catch { message.error("事实 JSON 格式无效"); return false; }
        await rpc(method, { asset_id: asset.id, facts_json: facts, reason });
      } else {
        message.info(`请在商家交互会话中执行 ${method}`);
        return false;
      }
      message.success(
        `${asset.name}：${asset.nextAction?.label ?? method}已提交`,
      );
      await load();
      return true;
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "素材治理操作失败",
      );
      return false;
    }
  };
  const createCompetitor = async (values: {
    competitorName: string;
    sourceJson: string;
    summary: string;
    structureJson: string;
    sellingPointsJson: string;
    expressionJson: string;
  }) => {
    if (!canCompetitor) {
      message.error("当前会话为只读，缺少竞品审核权限");
      return;
    }
    try {
      [
        values.sourceJson,
        values.structureJson,
        values.sellingPointsJson,
        values.expressionJson,
      ].forEach((value) => JSON.parse(value));
      await rpc("knowledge.competitor.create", {
        competitor_name: values.competitorName,
        source_json: values.sourceJson,
        summary: values.summary,
        structure_json: values.structureJson,
        selling_points_json: values.sellingPointsJson,
        expression_json: values.expressionJson,
      });
      message.success("竞品公开信息已录入，仅可用于差异化参考");
      competitorForm.resetFields();
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "竞品信息录入失败",
      );
    }
  };
  const cancelDeletion = async (request: DataDeletionRequest, reason: string) => {
    if (!authorization.can("workspace.delete.execute")) {
      message.error("当前会话为只读，缺少数据治理权限");
      return false;
    }
    try {
      await submitDataDeletionDecision({
        decision: "cancel",
        requestId: request.id,
        reason,
        refresh: load,
      });
      message.success("删除申请已取消");
      return true;
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "取消删除申请失败",
      );
      return false;
    }
  };
  const approveDeletion = async (request: DataDeletionRequest, reason: string) => {
    if (!authorization.can("workspace.delete.execute")) {
      message.error("当前会话为只读，缺少数据治理权限");
      return false;
    }
    try {
      await submitDataDeletionDecision({
        decision: "approve",
        requestId: request.id,
        reason,
        refresh: load,
      });
      message.success(
        request.approvals.length
          ? "第二次审批已记录，等待外部执行证明"
          : "第一次审批已记录",
      );
      return true;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "删除审批失败");
      return false;
    }
  };
  const saveOffer = async (row: Offer) => {
    if (!canGlobalCommercial) {
      message.error("当前会话为只读，缺少商业配置权限");
      return;
    }
    const validation = offerChangeErrors(row);
    if (Object.keys(validation).length) {
      message.error(Object.values(validation)[0]);
      return;
    }
    try {
      const result = await rpc("ops.commercial.offer.upsert", {
        code: row.code,
        name: row.name,
        billing_cycle: row.billingCycle,
        price_cny: row.priceCny.toFixed(2),
        included_stores: String(row.includedStores),
        included_tasks: String(row.includedTasks),
        active: String(row.active),
        valid_from: row.validFrom,
        ...(row.validTo?.trim() ? { valid_to: row.validTo } : {}),
        expected_revision: String(row.revision),
        reason: row.changeReason!.trim(),
      });
      setOffers((current) =>
        current.map((item) =>
          item.code === row.code ? (result as unknown as Offer) : item,
        ),
      );
      message.success("套餐目录已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "套餐保存失败");
      await load();
    }
  };
  const saveAddon = async (row: Addon) => {
    if (!canGlobalCommercial) {
      message.error("当前会话为只读，缺少商业配置权限");
      return;
    }
    try {
      const result = await rpc("ops.commercial.addon.upsert", {
        code: row.code,
        name: row.name,
        kind: row.kind,
        price_cny: row.priceCny.toFixed(2),
        units: String(row.units),
        active: String(row.active),
        expected_revision: String(row.revision),
        reason: "运营台加购目录调整",
      });
      setAddons((current) =>
        current.map((item) =>
          item.code === row.code ? (result as unknown as Addon) : item,
        ),
      );
      message.success("加购目录已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "加购保存失败");
      await load();
    }
  };
  const saveCoupon = async (row: Coupon) => {
    if (!canGlobalCommercial) {
      message.error("当前会话为只读，缺少商业配置权限");
      return;
    }
    try {
      const result = await rpc("ops.commercial.coupon.upsert", {
        code: row.code,
        discount_type: row.discountType,
        discount_value: row.discountValue.toFixed(2),
        max_redemptions: String(row.maxRedemptions),
        active: String(row.active),
        expected_revision: String(row.revision),
        reason: "运营台优惠券调整",
      });
      setCoupons((current) =>
        current.map((item) =>
          item.code === row.code ? (result as unknown as Coupon) : item,
        ),
      );
      message.success("优惠券已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "优惠券保存失败");
      await load();
    }
  };
  const saveRollout = async (row: Rollout) => {
    if (!authorization.can("commercial.update")) {
      message.error("当前会话为只读，缺少商业配置权限");
      return;
    }
    try {
      const result = await rpc("ops.commercial.rollout.upsert", {
        offer_code: row.offerCode,
        ...(row.workspaceId ? { target_workspace_id: row.workspaceId } : {}),
        percentage: String(row.percentage),
        enabled: String(row.enabled),
        reason: row.reason || "运营台灰度调整",
        expected_revision: String(row.revision),
      });
      setRollouts((current) =>
        current.map((item) =>
          item.id === row.id ? (result as unknown as Rollout) : item,
        ),
      );
      message.success("灰度规则已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "灰度保存失败");
      await load();
    }
  };
  const loadModelMarkup = async () => {
    try {
      const value = await rpc("ops.commercial.model-markup.get");
      setModelMarkup(value as unknown as ModelMarkupPolicy);
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "计费倍率加载失败",
      );
    }
  };
  const saveModelMarkup = async () => {
    if (!canModelMarkup || !modelMarkup) {
      message.error("当前会话缺少计费配置权限");
      return;
    }
    if (!modelMarkupReason.trim()) {
      message.error("请填写变更原因");
      return;
    }
    try {
      const value = await rpc("ops.commercial.model-markup.update", {
        multiplier: modelMarkup.multiplier.toFixed(3),
        expected_revision: String(modelMarkup.revision),
        reason: modelMarkupReason.trim(),
      });
      setModelMarkup(value as unknown as ModelMarkupPolicy);
      setModelMarkupReason("");
      message.success("模型计费倍率已生效");
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "计费倍率保存失败",
      );
      await loadModelMarkup();
    }
  };
  const loadAutomationScope = async (scope: string) => {
    const requestId = ++automationScopeRequestRef.current;
    const params = prepareAutomationScopeLoad(scope, storeDirectory, {
      setScope: setAutomationScope,
      setPolicy: setAutomationPolicy,
      setScan: setAutomationScan,
    });
    try {
      const [policy, scan] = await Promise.all([
        rpc("automation.policy.get", params),
        rpc("automation.scan", params),
      ]);
      if (requestId !== automationScopeRequestRef.current) return;
      if (policy && typeof policy === "object" && !Array.isArray(policy))
        setAutomationPolicy((policy as { policy: AutomationPolicy }).policy);
      if (scan && typeof scan === "object" && !Array.isArray(scan))
        setAutomationScan(scan as unknown as AutomationScan);
    } catch (cause) {
      if (requestId === automationScopeRequestRef.current)
        message.error(
          cause instanceof Error ? cause.message : "店铺自动化策略加载失败",
        );
    }
  };
  const updateAutomation = async (
    enabled: boolean,
    reason = enabled
      ? "运营台保存定时扫描与风险告警策略"
      : "运营台暂停自动化运营",
  ) => {
    if (!canQueue) {
      message.error("当前会话为只读，不能修改自动化策略");
      return;
    }
    const current = automationPolicy;
    try {
      const hasWindow = Boolean(current?.windowStart || current?.windowEnd);
      const result = await rpc("automation.policy.update", {
        ...automationScopeParams(),
        enabled: String(enabled),
        sync_enabled: String(current?.syncEnabled ?? false),
        frequency_minutes: String(current?.frequencyMinutes ?? 60),
        retry_limit: String(current?.retryLimit ?? 2),
        ...(hasWindow
          ? {
              window_start: current?.windowStart ?? "",
              window_end: current?.windowEnd ?? "",
            }
          : { clear_window: "true" }),
        reason,
      });
      setAutomationPolicy((result as { policy: AutomationPolicy }).policy);
      message.success(enabled ? "自动化策略已保存并开启" : "自动化运营已暂停");
      await loadAutomationScope(automationScope);
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "自动化策略更新失败",
      );
    }
  };
  const updateAutomationSync = (syncEnabled: boolean) => {
    setAutomationPolicy((current: AutomationPolicy | undefined) =>
      current ? { ...current, syncEnabled } : current,
    );
  };
  const scanAutomation = async () => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少自动化运营权限");
      return;
    }
    try {
      const result = await rpc("automation.scan", automationScopeParams());
      setAutomationScan(result as unknown as AutomationScan);
      message.success("店铺健康扫描完成");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "店铺扫描失败");
    }
  };
  const assignQueueItem = async (
    itemType: "generation" | "publish" | "image",
    itemId: string,
    revision: number,
    operatorId: string,
  ) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少队列权限");
      return false;
    }
    const normalizedOperatorId = operatorId.trim();
    if (!normalizedOperatorId) return false;
    try {
      await rpc("ops.marketing.queue.assign", {
        item_type: itemType,
        item_id: itemId,
        operator_id: normalizedOperatorId,
        expected_revision: String(revision),
        reason: "运营台分配队列负责人",
      });
      message.success("队列负责人已分配");
      await load();
      return true;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "队列分配失败");
      return false;
    }
  };
  const reconcileImageExecution = async (input: { jobId: string; resolution: "completed" | "failed"; evidenceRef: string; reason: string; revision: number }) => {
    if (!canQueue) { message.error("当前会话为只读，缺少图片对账权限"); return false; }
    try {
      await rpc("ops.marketing.image.reconcile", { job_id: input.jobId, resolution: input.resolution, evidence_ref: input.evidenceRef.trim(), reason: input.reason.trim(), idempotency_key: crypto.randomUUID(), expected_revision: String(input.revision) });
      message.success(input.resolution === "completed" ? "图片执行已人工确认完成" : "图片执行已人工确认失败");
      await load();
      return true;
    } catch (cause) { message.error(cause instanceof Error ? cause.message : "图片执行收口失败"); return false; }
  };
  const pausePublishBatch = async (
    batch: MarketingQueue["batches"][number],
    reason: string,
  ) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少批量发布治理权限");
      return false;
    }
    try {
      await rpc("publish.batch.pause", {
        batch_id: batch.id,
        reason: normalizePublishBatchPauseReason(reason),
      });
      message.success("批量发布已暂停；已进入平台队列的项目仍会继续观测");
      window.setTimeout(() => void load(), 0);
      return true;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "暂停批量发布失败");
      return false;
    }
  };
  const resumePublishBatch = async (batch: MarketingQueue["batches"][number]) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少批量发布治理权限");
      return false;
    }
    try {
      await rpc("publish.batch.resume", { batch_id: batch.id });
      message.success("批量发布已恢复；失败项仍需提供新的逐项确认后重试");
      window.setTimeout(() => void load(), 0);
      return true;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "恢复批量发布失败");
      return false;
    }
  };
  const retryFailedPublishBatch = async (
    batch: MarketingQueue["batches"][number],
    confirmationsJson: string,
  ) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少批量发布治理权限");
      return false;
    }
    try {
      await rpc("publish.batch.retry_failed", {
        batch_id: batch.id,
        confirmations_json: normalizePublishBatchConfirmations(confirmationsJson),
      });
      message.success("批量失败项已按新的逐项确认提交；请继续观测平台回执");
      window.setTimeout(() => void load(), 0);
      return true;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "批量失败项重试失败");
      return false;
    }
  };
  const retryGeneration = async (job: MarketingQueue["generation"][number]) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少队列权限");
      return;
    }
    try {
      await rpc("ops.marketing.generation.retry", {
        job_id: job.id,
        reason: "运营台确认失败原因后重新入队",
      });
      message.success("生成任务已安全重新入队");
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "生成任务重试失败",
      );
    }
  };
  const acknowledgePublish = async (job: MarketingQueue["publish"][number]) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少队列权限");
      return;
    }
    try {
      await rpc("ops.marketing.publish.acknowledge", {
        publish_job_id: job.id,
        reason: "运营台确认平台异常，转人工处理，不重放旧请求",
      });
      message.success("发布异常已确认");
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "发布异常确认失败",
      );
    }
  };
  const createRevision = async (job: MarketingQueue["publish"][number], values: RevisionCreationValues) => {
    if (!canQueue) {
      const error = "当前会话为只读，缺少队列权限";
      message.error(error);
      return { ok: false as const, error };
    }
    try {
      await submitRevisionCreation({ publishJobId: job.id, ...values }, {
        request: (params) => rpc("ops.marketing.revision.create", params),
        refresh: load,
      });
      message.success("修正版已创建，等待重新审核");
      return { ok: true as const };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "创建修正版失败";
      message.error(error);
      return { ok: false as const, error };
    }
  };
  const reviewVisual = async (
    visual: MarketingQueue["visuals"][number],
    status: "passed" | "blocked",
    reason?: string,
  ) => {
    if (!canQueue) {
      message.error("当前会话为只读，缺少队列权限");
      return;
    }
    try {
      await rpc("ops.marketing.visual.review", {
        visual_refs_json: JSON.stringify([visual.visualRef]),
        status,
        expected_revision: String(visual.revision),
        reason: reason?.trim() ||
          (status === "passed"
            ? "运营台完成视觉候选审查"
            : "运营台阻断视觉候选，等待重新生成或人工处理"),
      });
      message.success(
        status === "passed" ? "视觉候选已标记通过" : "视觉候选已阻断",
      );
      await load();
    } catch (cause) {
      message.error(
        cause instanceof Error ? cause.message : "视觉候选审查失败",
      );
    }
  };

  return {
    settings,
    setSettings,
    platformRows,
    setPlatformRows,
    audits,
    setAudits,
    auditCenterClient,
    subscription,
    setSubscription,
    orders,
    setOrders,
    members,
    setMembers,
    userDirectory,
    setUserDirectory,
    userDirectoryLoading,
    userDirectoryError,
    userExporting,
    userDetail,
    setUserDetail,
    userDetailLoading,
    workspaceRows,
    setWorkspaceRows,
    workspaceDirectory,
    workspaceDirectoryLoading,
    reconciliation,
    setReconciliation,
    rechargeOrders,
    rechargeOrdersLoading,
    rechargeOrdersError,
    rechargeOrderStateFilter,
    queryingRechargeOrderId,
    offers,
    setOffers,
    addons,
    setAddons,
    coupons,
    setCoupons,
    rollouts,
    setRollouts,
    modelMarkup,
    setModelMarkup,
    modelMarkupReason,
    setModelMarkupReason,
    funnel,
    setFunnel,
    platformHealth,
    setPlatformHealth,
    platformOperations,
    setPlatformOperations,
    storeDirectory,
    setStoreDirectory,
    brandNavigation,
    setBrandNavigation,
    dataLifecycle,
    setDataLifecycle,
    productionEvidence,
    setProductionEvidence,
    alerts,
    setAlerts,
    deletionRequests,
    setDeletionRequests,
    modelStatus,
    setModelStatus,
    modelStatusLoading,
    rules,
    setRules,
    ruleSyncStatuses,
    setRuleSyncStatuses,
    ruleSyncLoading,
    ruleMutationKey,
    knowledgeRules,
    setKnowledgeRules,
    knowledgeAssets,
    setKnowledgeAssets,
    learningSuggestions,
    setLearningSuggestions,
    competitors,
    setCompetitors,
    workspaceMetrics,
    setWorkspaceMetrics,
    storageReconciliationWorkspaces,
    marketingQueue,
    platformTaskSummary,
    setPlatformTaskSummary,
    platformBrandUnitSummary,
    setPlatformBrandUnitSummary,
    canonicalProductConsistency,
    setCanonicalProductConsistency,
    platformMarketingSummary,
    setPlatformMarketingSummary,
    platformModelUsageSummary,
    setPlatformModelUsageSummary,
    setMarketingQueue,
    queueFilters,
    setQueueFilters,
    alertFilters,
    setAlertFilters,
    automationPolicy,
    setAutomationPolicy,
    automationPolicies,
    setAutomationPolicies,
    automationScan,
    setAutomationScan,
    automationScope,
    setAutomationScope,
    selectedStoreScope,
    setSelectedStoreScope,
    opsSession,
    setOpsSession,
    clearAuthorizationScopedData,
    authorization,
    opsWorkspaceId,
    supportClient,
    incidentsClient,
    featureFlagsClient,
    canWriteFeatureFlags,
    canEmergencyFeatureFlags,
    financeSearchClient,
    dataSource,
    loading,
    setLoading,
    saving,
    setSaving,
    refundSubmitting,
    error,
    setError,
    dataSetError,
    dataSetErrorEvidence,
    memberForm,
    refundForm,
    ruleForm,
    knowledgeRuleForm,
    knowledgeAssetForm,
    competitorForm,
    load,
    loadRules,
    loadRechargeOrders,
    queryRechargeOrder,
    enabledCount,
    can,
    canFinance,
    canPaymentReconciliation,
    canModelSettlement,
    canBillingExport,
    canAuditExport,
    canPlatformOps,
    canGlobalCommercial,
    canUserGovernance,
    canModelMarkup,
    canKnowledge,
    canCompetitor,
    canRules,
    canQueue,
    canMembers,
    selectedAutomationStore,
    automationScopeParams,
    updateRuleStatus,
    publishRuleDraft,
    saveCommercial,
    savePlatform,
    saveStoreAlias,
    createBrand,
    revokeStore,
    saveMember,
    loadUsers,
    loadWorkspaceDirectory,
    exportUsers,
    cancelUserRequests,
    exportCommercial,
    suspendUsers,
    loadUserDetail,
    suspendUser,
    activateUser,
    changeIdentityAccess,
    transitionIdentityRisk,
    revokeIdentitySession,
    changeWorkspaceStatus,
    refund,
    runReconciliation,
    runModelUsageReconciliation,
    retryModelUsageSettlement,
    waiveModelUsageSettlement,
    markModelUsageForManualAttention,
    exportBilling,
    exportOperations,
    acknowledgeAlert,
    confirmLearning,
    createKnowledgeRule,
    createKnowledgeAsset,
    updateKnowledgeAsset,
    dismissLearning,
    governUploadedAsset,
    createCompetitor,
    cancelDeletion,
    approveDeletion,
    saveOffer,
    saveAddon,
    saveCoupon,
    saveRollout,
    loadModelMarkup,
    saveModelMarkup,
    loadAutomationScope,
    updateAutomation,
    updateAutomationSync,
    scanAutomation,
    assignQueueItem,
    reconcileImageExecution,
    pausePublishBatch,
    resumePublishBatch,
    retryFailedPublishBatch,
    retryGeneration,
    acknowledgePublish,
    createRevision,
    reviewVisual,
  };
}

export type OpsConsoleModel = ReturnType<typeof useOpsConsoleModel>;
