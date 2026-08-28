export const platforms = [
  "jd",
  "taobao",
  "tmall",
  "pinduoduo",
  "xiaohongshu",
  "douyin",
] as const;
export const platformLabels: Record<Platform, string> = {
  jd: "京东",
  taobao: "淘宝",
  tmall: "天猫",
  pinduoduo: "拼多多",
  xiaohongshu: "小红书",
  douyin: "抖音",
};
export type Platform = (typeof platforms)[number];
export type Settings = {
  planCode: string;
  planName: string;
  monthlyPriceCny: number;
  annualPriceCny: number;
  includedStores: number;
  includedTasks: number;
  revision: number;
};
export type PlatformSetting = {
  platform: Platform;
  enabled: boolean;
  displayName: string;
  storeAlias: string;
  revision: number;
  changeReason?: string;
};
export type Audit = {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  reason: string;
  createdAt: string;
};
export type Subscription = {
  status: string;
  planName: string;
  billingCycle: string;
  priceCny: number;
  currentPeriodEnd: string;
};
export type Order = {
  id: string;
  orderNo: string;
  planName: string;
  billingCycle: string;
  priceCny: number;
  status: string;
  createdAt: string;
};
export type Member = {
  id: string;
  identityId?: string;
  externalSubject: string;
  displayName: string;
  role: string;
  status: string;
  updatedAt: string;
};
export type PlatformUser = Member & {
  workspaceId: string;
  workspaceStatus: "active" | "disabled";
  invitedBy?: string;
  commercial?: {
    planCode: string;
    planName: string;
    subscriptionStatus: string;
    usedTasks: number;
    includedTasks: number;
    remainingTasks: number;
    walletBalanceCny: string;
  };
};
export type PlatformUserDirectory = {
  items: PlatformUser[];
  total: number;
  identityCount: number;
  workspaceCount: number;
  offset: number;
  limit: number;
  truncated: boolean;
};
export type PlatformUserDetail = {
  identity: {
    id?: string;
    externalSubject: string;
    displayName: string;
    accessStatus?: "active" | "suspended";
    riskLevel?: "low" | "medium" | "high" | "critical";
    riskDecision?: "allow" | "step_up" | "block";
    authEpoch?: number;
    revision?: number;
    membershipCount: number;
    activeMembershipCount: number;
    firstSeenAt: string;
    lastUpdatedAt: string;
  };
  memberships: PlatformUser[];
  audits: Audit[];
  sessions: Array<{ id: string; sessionKind: "oidc" | "api_token"; status: "active" | "revoked" | "expired"; mfaVerified: boolean; issuedAt: string; expiresAt?: string; lastSeenAt: string; revision: number }>;
  lifecycleEvents: Array<{ id: string; eventType: string; actorId: string; reason: string; createdAt: string }>;
};
export type WorkspaceSummary = {
  workspaceId: string;
  status: string;
  planName: string;
  monthlyPriceCny: number;
  usedTasks: number;
  includedTasks: number;
  subscriptionStatus: string;
  memberCount: number;
};
export type Offer = {
  id: string;
  code: string;
  name: string;
  billingCycle: string;
  priceCny: number;
  includedStores: number;
  includedTasks: number;
  active: boolean;
  revision: number;
};
export type Addon = {
  id: string;
  code: string;
  name: string;
  kind: string;
  priceCny: number;
  units: number;
  active: boolean;
  revision: number;
};
export type Coupon = {
  id: string;
  code: string;
  discountType: string;
  discountValue: number;
  maxRedemptions: number;
  redeemedCount: number;
  active: boolean;
  revision: number;
};
export type Rollout = {
  id: string;
  offerCode: string;
  workspaceId?: string;
  percentage: number;
  enabled: boolean;
  reason: string;
  revision: number;
};
export type ModelMarkupPolicy = {
  multiplier: number;
  reason: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
};
export type GrowthFunnel = {
  counts: Record<string, number>;
  totalEvents: number;
};
export type OperationalAlert = {
  id: string;
  code: string;
  severity: "high" | "medium";
  platform?: string;
  accountId?: string;
  entityType: string;
  entityId: string;
  title: string;
  status: "open" | "acknowledged";
  observedAt: string;
  evidence: Record<string, unknown>;
  nextAction: string;
  acknowledgementReason?: string;
};
export type ModelStatus = {
  ownership: string;
  user_key_binding: boolean;
  state: string;
  provider_host: string | null;
  text_model: string | null;
  image_model: string | null;
  vision_model?: string | null;
  video_model?: string | null;
  relay?: { configured: boolean; host: string | null; reasons?: string[] };
  capabilities: {
    text_generation: boolean;
    image_generation: boolean;
    image_editing?: boolean;
    image_fact_ocr?: boolean;
    video_rendering?: boolean;
  };
  model_readiness?: Record<
    string,
    { ready: boolean; provider_configured?: boolean; reasons?: string[] }
  >;
  quotas: {
    rpm: number | null;
    tpm: number | null;
    daily_cny_limit: string | null;
  };
  cost_control_ready?: boolean;
  cost_evidence_ready?: boolean;
  release_metadata_ready?: boolean;
  release_metadata_missing?: string[];
  next_actions: string[];
};
export type Rule = {
  id: string;
  packId: string;
  name: string;
  version: string;
  status: string;
  lifecycleStatus?: string;
  scope: string;
  scopeValue?: string;
  source: { kind: string; reference: string; checkedAt: string };
  revision: number;
  effectiveFrom?: string;
  effectiveTo?: string;
};
export type KnowledgeAsset = {
  id: string;
  kind: "brand" | "customer";
  name: string;
  source?: string;
  approvalStatus: "pending" | "approved" | "rejected";
  rightsStatus: "unknown" | "cleared" | "restricted";
  revision: number;
  updatedAt: string;
};
export type LearningSuggestion = {
  id: string;
  feedbackId: string;
  status: "pending" | "confirmed" | "dismissed";
  summary: string;
  proposedRule: { scope: string; scopeValue?: string; content: string };
  createdAt: string;
  confirmedBy?: string;
};
export type CompetitorAnalysis = {
  id: string;
  competitorName: string;
  source: { title: string; url: string; accessedAt: string };
  summary: string;
  sellingPoints: string[];
  createdAt: string;
};
export type WorkspaceMetrics = {
  jobs?: {
    sync: number;
    generation: number;
    generationFailed: number;
    publish: number;
  };
  recommendations?: Array<{
    priority: string;
    title: string;
    action: string;
    evidence: string[];
  }>;
  quality?: { p0FindingCount: number; modelFailureRate: number };
};
export type UploadedAssetRisk = {
  id: string;
  name: string;
  mimeType: string;
  scanStatus: string;
  parseStatus: string;
  rightsStatus: string;
  rightsScope?: string | null;
  readiness: { status: string; reasons: string[] };
  revision: number;
  createdAt: string;
  nextAction?: {
    method: string;
    label: string;
    requiredInputs: string[];
  } | null;
  nextStep?: string;
};
export type MarketingQueue = {
  generation: Array<{
    id: string;
    taskId: string;
    state: string;
    attempt: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    assignedOperatorId?: string | null;
    assignedAt?: string | null;
    revision: number;
    updatedAt: string;
  }>;
  publish: Array<{
    id: string;
    taskId: string;
    platform: string;
    state: string;
    remoteState?: string | null;
    rejection?: { rawCode?: string; message?: string } | null;
    operatorAcknowledgement?: {
      actorId: string;
      reason: string;
      acknowledgedAt: string;
    } | null;
    assignedOperatorId?: string | null;
    assignedAt?: string | null;
    revision: number;
    createdAt: string;
  }>;
  visuals: Array<{
    jobId: string;
    visualRef: string;
    ordinal: number;
    productId: string;
    taskId?: string | null;
    contentVersionId?: string | null;
    skuIds: string[];
    reviewStatus: string;
    assignedOperatorId?: string | null;
    assignedAt?: string | null;
    revision: number;
    updatedAt: string;
  }>;
  batches: Array<{
    id: string;
    state: string;
    itemCount: number;
    queuedCount: number;
    failedCount: number;
    pauseReason?: string | null;
    updatedAt: string;
  }>;
  learningSuggestions: LearningSuggestion[];
  assetRisks: KnowledgeAsset[];
  uploadedAssetRisks: UploadedAssetRisk[];
};
export type QueueFilters = {
  platform?: Platform;
  accountId?: string;
  productId?: string;
  taskId?: string;
  state?: string;
};
export type AlertFilters = {
  platform?: Platform;
  accountId?: string;
  code?: string;
  entityType?: string;
  entityId?: string;
};
export type PlatformHealth = {
  ready?: boolean;
  reasons?: string[];
  productionCanaryReady?: boolean;
  mediaUpload?: {
    ready: boolean;
    configured: boolean;
    evidence: boolean;
    reason?: string;
  };
};
export type OpsDataSource = {
  environment?: string;
  persistence?: "postgres" | "memory" | string;
  plugin?: string;
  fixtureDataPresent?: boolean;
  officialStoreCount?: number;
  fixtureStoreCount?: number;
};
export type PlatformOperation = {
  platform: string;
  state?: string;
  accountId?: string;
  readEnabled?: boolean;
  writeEnabled?: boolean;
  capabilities?: Array<{
    capability: string;
    state: string;
    verifiedAt?: string;
  }>;
  readiness?: PlatformHealth;
};
export type StoreDirectory = {
  platform: Platform;
  accountId: string;
  alias?: string;
  storeName?: string;
  label: string;
  state: string;
  dataMode: string;
  readable: boolean;
  writeEnabled: boolean;
  authorization?: {
    reauthorizationRequired?: boolean;
    lastKnownExpiryState?: string;
    grantedScopes?: string[];
  };
  sync?: {
    latestState?: string | null;
    lastSuccessfulAt?: string | null;
    failedItems?: number;
  };
  revision: number;
};
export type BrandNavigationItem = {
  id: string;
  title: string;
  platforms: Array<{
    id: string;
    platform: string;
    title: string;
    stores: Array<{ id: string; accountId: string }>;
  }>;
};
export type DataLifecycle = {
  state: "not_required" | "ready" | "blocked";
  configured?: boolean;
  objectVersioning?: boolean;
  retentionDays?: number;
  quarantineRetentionDays?: number;
  cleanRetentionDays?: number;
  deletionGraceDays?: number;
  backupRetentionDays?: number;
  reasons?: string[];
};
export type EvidenceReadiness = {
  kind?: string;
  state: "not_required" | "blocked" | "ready";
  configured?: boolean;
  sourceRef?: string;
  schemaVersion?: string;
  releaseId?: string;
  environment?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  profile?: string;
  reasons?: string[];
};
export type DataDeletionRequest = {
  id: string;
  scope: "workspace" | "assets" | "business";
  reason: string;
  requestedBy: string;
  requestedAt: string;
  gracePeriodDays: number;
  scheduledFor: string;
  status: "pending" | "approved" | "cancelled" | "completed" | "incomplete";
  approvals: Array<{ actorId: string; approvedAt: string; reason: string }>;
  cancellationReason?: string;
};
export type ModelUsageSettlementStatus =
  | "pending_cost"
  | "pending_wallet"
  | "manual_attention"
  | "settled"
  | "waived";
export type ModelUsageSettlementDecision =
  | "retry"
  | "waive"
  | "manual_attention";

export type ModelUsageSettlementRecord = {
  id: string;
  action_id: string | null;
  modality: string;
  model: string;
  provider_request_id: string | null;
  observed_at: string;
  settlement_status?: ModelUsageSettlementStatus;
  allowed_decisions?: ModelUsageSettlementDecision[];
  settlement_reason: string;
  attempt_count?: number;
  next_attempt_at?: string | null;
  revision?: number;
  last_error?: { code?: string; message?: string } | null;
};

export type Reconciliation = {
  balance_cny: string;
  recharge_cny: string;
  debit_cny: string;
  refund_cny: string;
  transaction_count: number;
  transactions: Array<{
    id: string;
    type: string;
    amount_cny: string;
    description: string;
    createdAt: string;
  }>;
  model_usage?: {
    record_count: number;
    total_tokens: number;
    provider_cost_cny: string | null;
    customer_charge_cny: string;
    unsettled_records: number;
    by_modality: Record<string, number>;
    unsettled: ModelUsageSettlementRecord[];
  };
  provider?: { mode: string; ready: boolean; reasons: string[] };
};

export type RechargeOrderState = "pending" | "paid" | "closed" | "failed";

export type RechargeOrder = {
  id: string;
  workspace_id: string;
  channel: string;
  amount_cny: string;
  state: RechargeOrderState;
  payment_url: string | null;
  provider_trade_id: string | null;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string;
};

export type RechargeOrderSummary = {
  total?: number;
  amount_cny?: string;
  total_amount_cny?: string;
  by_state?: Partial<Record<RechargeOrderState, number>>;
  pending?: number;
  paid?: number;
  closed?: number;
  failed?: number;
};

export type RechargeOrderList = {
  orders: RechargeOrder[];
  summary?: RechargeOrderSummary;
  returned?: number;
  total?: number;
};
export type AutomationPolicy = {
  id?: string;
  platform?: Platform;
  accountId?: string;
  enabled: boolean;
  syncEnabled?: boolean;
  mode: string;
  frequencyMinutes: number;
  retryLimit: number;
  windowStart?: string;
  windowEnd?: string;
  pauseReason?: string;
  nextRunAt?: string;
  revision: number;
  store?: StoreDirectory | null;
};
export type AutomationScan = {
  counts: { products: number; publishJobs: number; risks: number };
  risks: Array<{
    kind: string;
    message: string;
    product_id?: string;
    publish_job_id?: string;
  }>;
  recommendations?: Array<{
    id: string;
    kind: string;
    priority: "high" | "medium";
    title: string;
    action: string;
    method: string;
    parameters: Record<string, string>;
    execution: "read_only" | "interactive_confirmation";
    requiresInteractiveConfirmation: boolean;
  }>;
  unattendedAutoResubmit: boolean;
};
export type OpsSession = {
  actor_id: string;
  workspace_id: string;
  roles: string[];
  workspace_granted: boolean;
};
export type RpcErrorPayload = { code?: string; message?: string };
export type Rpc = {
  result?: {
    settings?: Settings;
    platforms?: PlatformSetting[];
    subscription?: Subscription;
    orders?: Order[];
    policy?: AutomationPolicy;
    policies?: AutomationPolicy[];
  };
  data?: { result?: Rpc["result"]; error?: RpcErrorPayload | null };
  error?: RpcErrorPayload | null;
};

export type OpsRequestError = Error & { code?: string; httpStatus?: number };
