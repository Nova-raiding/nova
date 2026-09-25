import { managedOpsSession, opsApiBase, readOpsConnectionConfig, rpc } from "./opsClient.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";

export interface CustomerDeliveryClient {
  listAccounts(input: { targetWorkspaceId: string; search?: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<CustomerDeliveryAccountPage>;
  bindAccount(input: { targetWorkspaceId: string; deliveryId: string; targetAccountId: string; expectedRevision: number; reason: string }, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  uploadAsset(input: CustomerDeliveryAssetUploadInput, signal?: AbortSignal): Promise<CustomerDeliveryAsset>;
  getAsset(input: { targetWorkspaceId: string; deliveryId: string; purpose: CustomerDeliveryAssetPurpose; assetRef: string }, signal?: AbortSignal): Promise<CustomerDeliveryAsset>;
  list(input: { targetWorkspaceId: string; offset?: number; limit?: number; query?: string; projectOwner?: string; supportOwner?: string }, signal?: AbortSignal): Promise<CustomerDeliveryPage | null>;
  get(targetWorkspaceId: string, deliveryId: string, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  create(targetWorkspaceId: string, companyName: string, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  update(input: { targetWorkspaceId: string; deliveryId: string; patch: Record<string, unknown>; expectedRevision: number }, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  updateChecklist(input: {
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    items: Array<{ itemKey: string; completed: boolean; evidence: string; evidenceAssetRefs: string[] }>;
    expectedRevision: number;
    targetWorkspaceId: string;
  }, signal?: AbortSignal): Promise<{ items: CustomerDeliveryChecklistItem[]; revision?: number }>;
  listChecklistItems(input: { targetWorkspaceId: string; deliveryId: string; checklistKey: "system_integration" | "functional_acceptance" }, signal?: AbortSignal): Promise<CustomerDeliveryChecklistItem[]>;
  updateChecklistItem(input: {
    targetWorkspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    itemKey: string;
    completed: boolean;
    evidence?: Record<string, unknown>;
    expectedRevision: number;
  }, signal?: AbortSignal): Promise<CustomerDeliveryChecklistItem>;
  completeTraining(input: { targetWorkspaceId: string; deliveryId: string; completed: boolean; evidenceAssetRefs: string[]; expectedRevision: number }, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  listVideos(targetWorkspaceId: string, deliveryId: string, signal?: AbortSignal): Promise<Array<{ id: string; title: string; assetRef: string; sortOrder: number }>>;
  addVideo(input: { targetWorkspaceId: string; deliveryId: string; title: string; assetRef: string; sortOrder?: number }, signal?: AbortSignal): Promise<unknown>;
  downloadAsset(input: { targetWorkspaceId: string; deliveryId: string; purpose: "contract" | "video"; assetRef: string }, signal?: AbortSignal): Promise<{ blob: Blob; fileName: string }>;
}
export interface CustomerDeliveryPage {
  items: CustomerDeliveryRecord[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  projectOwnerOptions: string[];
  supportOwnerOptions: string[];
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const bool = (value: unknown): value is boolean => typeof value === "boolean";

export interface CustomerDeliveryAccount { workspaceId: string; accountId: string; identityId: string; login: string }
export interface CustomerDeliveryAccountPage { items: CustomerDeliveryAccount[]; nextCursor?: string }
const nonempty = (value: unknown): value is string => text(value) && Boolean(value.trim()) && !/[\p{Cc}\p{Cf}]/u.test(value);

export function parseCustomerDeliveryAccounts(value: unknown, workspaceId: string): CustomerDeliveryAccountPage {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 50 || (value.nextCursor !== undefined && !nonempty(value.nextCursor))) throw new Error("生效账号目录响应无效，请重试");
  const accounts = new Set<string>();
  const identities = new Set<string>();
  const items = value.items.map((row) => {
    if (!object(row) || row.workspaceId !== workspaceId || !nonempty(row.accountId) || !nonempty(row.identityId) || !nonempty(row.login) || accounts.has(row.accountId) || identities.has(row.identityId)) throw new Error("生效账号目录返回了无效或不属于当前企业的账号，请重试");
    accounts.add(row.accountId); identities.add(row.identityId);
    return { workspaceId, accountId: row.accountId, identityId: row.identityId, login: row.login };
  });
  return { items, ...(value.nextCursor !== undefined ? { nextCursor: String(value.nextCursor) } : {}) };
}

export function parseCustomerDeliveryAccountBinding(row: Record<string, unknown>) {
  const values = [row.targetAccountId, row.targetIdentityId, row.targetAccountLogin];
  if (values.every((value) => value === undefined || value === null)) return { targetAccountId: null, targetIdentityId: null, targetAccountLogin: null };
  if (!values.every(nonempty)) throw new Error("生效账号关联信息不完整，请刷新档案；不能据此判断账号已启用");
  return { targetAccountId: values[0] as string, targetIdentityId: values[1] as string, targetAccountLogin: values[2] as string };
}

export type CustomerDeliveryAssetPurpose = "contract" | "payment" | "system_integration" | "functional_acceptance" | "training" | "video";
export type CustomerDeliveryUploadSource = File | { sourceUrl: string };
export type CustomerDeliveryAssetUploadInput = { targetWorkspaceId: string; deliveryId: string } & (
  | { purpose: CustomerDeliveryAssetPurpose; file: File; sourceUrl?: never }
  | { purpose: "contract"; sourceUrl: string; file?: never }
);
export interface CustomerDeliveryAsset {
  assetRef: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: "pending" | "clean" | "unscanned" | "blocked";
  ready: boolean;
}
export const CUSTOMER_DELIVERY_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Syntax-only feedback. The server must independently enforce DNS/IP and download safety. */
export function validateCustomerDeliveryContractUrl(sourceUrl: string): string {
  const value = sourceUrl.trim();
  if (!value) throw new Error("请填写合同文件直链");
  if (value.length > 2000) throw new Error("合同链接不能超过 2000 个字符，请下载文件后本地上传");
  if (/[\s\p{Cc}\p{Cf}\\]/u.test(value)) throw new Error("合同链接不能包含空白、控制字符或反斜线");
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(value)) throw new Error("合同链接不能包含编码后的控制字符或反斜线");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("请填写完整的 HTTPS 合同文件直链"); }
  if (!/^https:\/\//iu.test(value) || url.protocol !== "https:" || (url.port && url.port !== "443")) throw new Error("合同链接必须使用 HTTPS 默认端口（443）");
  if (url.username || url.password || /^https:\/\/[^/?#]*@/iu.test(value) || url.hash || value.includes("#")) throw new Error("合同链接不能包含登录凭据或片段标记");
  return value;
}
const deliveryFileTypes: Record<CustomerDeliveryAssetPurpose, Record<string, string>> = {
  contract: { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
  payment: { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
  system_integration: { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
  functional_acceptance: { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
  training: { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
  video: { mp4: "video/mp4", webm: "video/webm" },
};

export function validateCustomerDeliveryFile(file: Pick<File, "name" | "size" | "type">, purpose: CustomerDeliveryAssetPurpose): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = deliveryFileTypes[purpose][extension];
  if (!mimeType) throw new Error(purpose === "video" ? "交付视频仅支持 MP4、WebM 文件" : "交付凭证仅支持 PDF、DOCX、PNG、JPG、JPEG 文件");
  if (!file.name.trim() || /[\u0000-\u001f/\\]/u.test(file.name)) throw new Error("文件名无效，请重命名后重试");
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("不能上传空文件");
  if (file.size > CUSTOMER_DELIVERY_MAX_FILE_BYTES) throw new Error("单个文件不能超过 50 MiB");
  const declaredType = file.type.toLowerCase();
  if (declaredType && declaredType !== "application/octet-stream" && declaredType !== mimeType && !(mimeType === "image/jpeg" && declaredType === "image/jpg")) throw new Error("文件类型与扩展名不一致，请检查文件后重试");
  return mimeType;
}

export function parseCustomerDeliveryAsset(value: unknown): CustomerDeliveryAsset {
  if (!object(value) || !text(value.assetRef) || !/^asset[:_]\S+$/u.test(value.assetRef) || !text(value.name) || !value.name.trim() || !text(value.mimeType) || !value.mimeType.trim() || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0 || Number(value.sizeBytes) > CUSTOMER_DELIVERY_MAX_FILE_BYTES || !["pending", "clean", "unscanned", "blocked"].includes(String(value.scanStatus)) || !bool(value.ready) || (value.ready && value.scanStatus !== "clean" && value.scanStatus !== "unscanned")) {
    throw new Error("客户交付素材接口返回了无效的文件或安全检查状态");
  }
  return value as unknown as CustomerDeliveryAsset;
}

/** Use an abortable FileReader: closing a drawer must stop local file reading. */
export async function readCustomerDeliveryFile(file: File, purpose: CustomerDeliveryAssetPurpose, signal?: AbortSignal) {
  const mimeType = validateCustomerDeliveryFile(file, purpose);
  signal?.throwIfAborted();
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reader.abort();
      reject(new DOMException("文件读取已取消", "AbortError"));
    };
    reader.onload = () => {
      cleanup();
      if (!(reader.result instanceof ArrayBuffer)) reject(new Error("无法读取文件内容，请重新选择文件"));
      else resolve(reader.result);
    };
    reader.onerror = () => { cleanup(); reject(new Error("文件读取失败，请检查文件后重试")); };
    reader.onabort = () => { cleanup(); reject(new DOMException("文件读取已取消", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsArrayBuffer(file);
  });
  signal?.throwIfAborted();
  if (bytes.byteLength !== file.size) throw new Error("文件读取不完整，请重新选择文件");
  if (!globalThis.crypto?.subtle) throw new Error("当前连接不支持文件安全校验，请使用 HTTPS 或本机地址");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  signal?.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const parts: string[] = [];
  const data = new Uint8Array(bytes);
  // Chunked conversion avoids overflowing the call stack for a 50 MiB video.
  for (let index = 0; index < data.length; index += 0x8000) parts.push(String.fromCharCode(...data.subarray(index, index + 0x8000)));
  signal?.throwIfAborted();
  return { name: file.name, mimeType, contentBase64: btoa(parts.join("")), sha256 };
}

export interface CustomerDeliveryChecklistItem { itemKey: string; completed: boolean; evidence: string; evidenceAssetRefs: string[] }

export function parseCustomerDeliveryEvidenceRefs(value: unknown, label = "交付凭证"): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string" || !/^asset[:_][^\s]+$/u.test(ref.trim()))) {
    throw new Error(`${label}必须是有效素材编号数组`);
  }
  return [...new Set(value.map((ref) => String(ref).trim()))];
}

function parseEvidenceRefMap(value: unknown, label: string): Record<string, string[]> {
  if (value === undefined || value === null) return {};
  if (!object(value)) throw new Error(`${label}必须是有效素材编号映射`);
  return Object.fromEntries(Object.entries(value).map(([itemKey, refs]) => {
    if (!itemKey.trim()) throw new Error(`${label}包含无效清单项`);
    return [itemKey, parseCustomerDeliveryEvidenceRefs(refs, `${label}（${itemKey}）`)];
  }));
}

export function buildChecklistUpdateParams(input: {
  targetWorkspaceId: string;
  deliveryId: string;
  checklistKey: "system_integration" | "functional_acceptance";
  items: Array<{ itemKey: string; completed: boolean; evidence: string; evidenceAssetRefs?: string[] }>;
  expectedRevision: number;
}) {
  return {
    delivery_id: input.deliveryId,
    target_workspace_id: input.targetWorkspaceId,
    checklist_key: input.checklistKey,
    items_json: JSON.stringify(input.items.map((item) => ({ itemKey: item.itemKey, completed: item.completed, evidence: { note: item.evidence, asset_refs: parseCustomerDeliveryEvidenceRefs(item.evidenceAssetRefs, `${item.itemKey}凭证`) } }))),
    expected_revision: String(input.expectedRevision),
  };
}

function parseRecord(value: unknown): CustomerDeliveryRecord {
  const rows = parseCustomerDeliveryList({ items: [value], total: 1, offset: 0, limit: 1, hasMore: false, project_owner_options: [], support_owner_options: [] });
  const row = rows.items[0];
  if (!row) throw new Error("客户交付接口返回了空记录");
  return row;
}

export function parseCustomerDeliveryChecklistItems(value: unknown): CustomerDeliveryChecklistItem[] {
  const rows = object(value) && Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : null;
  if (!rows) throw new Error("客户交付接口返回了无效清单响应");
  return rows.map((item, index) => {
    if (!object(item) || !text(item.itemKey ?? item.item_key) || typeof item.completed !== "boolean") throw new Error(`客户交付清单响应无效（第 ${index + 1} 项）`);
    let rawEvidence = item.evidence ?? item.evidence_json;
    if (item.evidence === undefined && typeof item.evidence_json === "string") {
      try { rawEvidence = JSON.parse(item.evidence_json); }
      catch { throw new Error(`客户交付清单凭证 JSON 无效（第 ${index + 1} 项）`); }
    }
    if (rawEvidence !== undefined && rawEvidence !== null && typeof rawEvidence !== "string" && !object(rawEvidence)) throw new Error(`客户交付清单凭证无效（第 ${index + 1} 项）`);
    if (object(rawEvidence) && rawEvidence.note !== undefined && typeof rawEvidence.note !== "string") throw new Error(`客户交付清单凭证说明无效（第 ${index + 1} 项）`);
    const evidence = typeof rawEvidence === "string" ? rawEvidence : object(rawEvidence) && typeof rawEvidence.note === "string" ? rawEvidence.note : "";
    const evidenceAssetRefs = parseCustomerDeliveryEvidenceRefs(object(rawEvidence) ? rawEvidence.asset_refs : item.evidenceAssetRefs, `第 ${index + 1} 项交付凭证`);
    return { itemKey: String(item.itemKey ?? item.item_key), completed: item.completed, evidence, evidenceAssetRefs };
  });
}

export function parseCustomerDeliveryVideos(value: unknown): Array<{ id: string; title: string; assetRef: string; sortOrder: number }> {
  if (!object(value) || !Array.isArray(value.items)) throw new Error("客户交付视频接口返回了无效响应");
  return value.items.map((row, index) => {
    if (!object(row) || !text(row.id) || !text(row.title) || !text(row.assetRef ?? row.asset_ref)) throw new Error(`客户交付视频响应无效（第 ${index + 1} 项）`);
    const sortOrder = Number(row.sortOrder ?? row.sort_order ?? 0);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error(`客户交付视频排序字段无效（第 ${index + 1} 项）`);
    return { id: row.id, title: row.title, assetRef: String(row.assetRef ?? row.asset_ref), sortOrder };
  });
}

/** Parse the server's snake_case aggregate without allowing malformed data to
 * silently appear as an empty customer list. */
export function parseCustomerDeliveryList(value: unknown): CustomerDeliveryPage {
  if (!object(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.total) || Number(value.total) < 0
    || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || !Number.isSafeInteger(value.limit)
    || Number(value.limit) < 1 || Number(value.limit) > 100 || typeof value.hasMore !== "boolean"
    || value.items.length > Number(value.limit) || value.hasMore !== (Number(value.offset) + Number(value.limit) < Number(value.total))
    || !Array.isArray(value.project_owner_options) || !value.project_owner_options.every(nonempty)
    || !Array.isArray(value.support_owner_options) || !value.support_owner_options.every(nonempty))
    throw new Error("客户交付接口返回了无效响应（分页）");
  const items: CustomerDeliveryRecord[] = value.items.map((row, index): CustomerDeliveryRecord => {
    if (!object(row) || !text(row.id) || !text(row.companyName ?? row.company_name)) throw new Error(`客户交付接口返回了无效响应（第 ${index + 1} 条）`);
    const status = row.paymentStatus ?? row.payment_status;
    if (status !== "paid" && status !== "unpaid") throw new Error(`客户交付接口返回了无效响应（付款状态，第 ${index + 1} 条）`);
    const profile = row.profile ?? row.customerProfileStatus === "complete";
    const integration = row.integration ?? row.systemIntegrationStatus === "complete";
    const acceptance = row.acceptance ?? row.functionalAcceptanceStatus === "complete";
    const training = row.training ?? row.trainingCompleted;
    if (![profile, integration, acceptance, training].every(bool)) throw new Error(`客户交付接口返回了无效响应（清单状态，第 ${index + 1} 条）`);
    let videos = 0;
    if (Array.isArray(row.videos)) {
      if (row.videos.some((video) => !object(video) || !text(video.id ?? video.assetRef ?? video.asset_ref))) throw new Error(`客户交付接口返回了无效视频（第 ${index + 1} 条）`);
      videos = row.videos.filter((video) => object(video) && !video.deletedAt && !video.deleted_at).length;
    } else if (typeof row.videos === "number") {
      if (!Number.isSafeInteger(row.videos) || row.videos < 0) throw new Error(`客户交付接口返回了无效视频数量（第 ${index + 1} 条）`);
      videos = row.videos;
    } else if (Array.isArray(row.videoUrls)) {
      if (row.videoUrls.some((url) => !text(url))) throw new Error(`客户交付接口返回了无效视频链接（第 ${index + 1} 条）`);
      videos = row.videoUrls.length;
    }
    return {
      id: row.id,
      ...parseCustomerDeliveryAccountBinding(row),
      companyName: (row.companyName ?? row.company_name) as string,
      paymentStatus: status,
      profile: profile as boolean, integration: integration as boolean, acceptance: acceptance as boolean, training: training as boolean, videos,
      ...(text(row.contractNo ?? row.contractNumber ?? row.contract_number) ? { contractNo: (row.contractNo ?? row.contractNumber ?? row.contract_number) as string } : {}),
      ...(text(row.owner ?? row.projectOwner ?? row.project_owner) ? { owner: (row.owner ?? row.projectOwner ?? row.project_owner) as string } : {}),
      ...(text(row.afterSalesOwner ?? row.supportOwner ?? row.support_owner) ? { afterSalesOwner: (row.afterSalesOwner ?? row.supportOwner ?? row.support_owner) as string } : {}),
      ...(text(row.paymentDate ?? row.payment_date) ? { paymentDate: (row.paymentDate ?? row.payment_date) as string } : {}),
      ...(text(row.requiredLaunchAt ?? row.plannedGoLiveAt ?? row.planned_go_live_at) ? { requiredLaunchAt: (row.requiredLaunchAt ?? row.plannedGoLiveAt ?? row.planned_go_live_at) as string } : {}),
      ...(text(row.contractFile ?? row.contractRef ?? row.contract_ref) ? { contractFile: (row.contractFile ?? row.contractRef ?? row.contract_ref) as string } : {}),
      paymentEvidenceRefs: parseCustomerDeliveryEvidenceRefs(row.paymentEvidenceRefs ?? row.payment_evidence_refs, "付款凭证"),
      trainingEvidenceRefs: parseCustomerDeliveryEvidenceRefs(row.trainingEvidenceRefs ?? row.training_evidence_refs, "培训凭证"),
      integrationEvidenceAssetRefs: parseEvidenceRefMap(row.integrationEvidenceAssetRefs, "系统接入凭证"),
      acceptanceEvidenceAssetRefs: parseEvidenceRefMap(row.acceptanceEvidenceAssetRefs, "功能验收凭证"),
      ...(text(row.effectiveAt ?? row.effective_at) ? { goLiveAt: (row.effectiveAt ?? row.effective_at) as string } : {}),
      ...(Array.isArray(row.videoUrls) ? { videoUrls: row.videoUrls.filter(text) } : {}),
      ...(typeof row.revision === "number" ? { revision: row.revision } : {}),
      ...(text(row.createdAt ?? row.created_at) ? { createdAt: String(row.createdAt ?? row.created_at) } : {}),
      ...(text(row.createdByActorId ?? row.created_by_actor_id) ? { createdByActorId: String(row.createdByActorId ?? row.created_by_actor_id) } : {}),
      ...(text(row.updatedByActorId ?? row.updated_by_actor_id) ? { updatedByActorId: String(row.updatedByActorId ?? row.updated_by_actor_id) } : {}),
      ...(Array.isArray(row.integrationItems) ? { integrationItems: row.integrationItems.filter(text) } : {}),
      ...(Array.isArray(row.acceptanceItems) ? { acceptanceItems: row.acceptanceItems.filter(text) } : {}),
      ...(object(row.integrationEvidence) ? { integrationEvidence: Object.fromEntries(Object.entries(row.integrationEvidence).filter(([,v]) => text(v)).map(([k,v]) => [k, String(v)])) } : {}),
      ...(object(row.acceptanceEvidence) ? { acceptanceEvidence: Object.fromEntries(Object.entries(row.acceptanceEvidence).filter(([,v]) => text(v)).map(([k,v]) => [k, String(v)])) } : {}),
    };
  });
  return {
    items,
    total: Number(value.total),
    offset: Number(value.offset),
    limit: Number(value.limit),
    hasMore: value.hasMore,
    projectOwnerOptions: [...new Set(value.project_owner_options as string[])],
    supportOwnerOptions: [...new Set(value.support_owner_options as string[])],
  };
}

export const customerDeliveryClient: CustomerDeliveryClient = {
  async listAccounts(input, signal) {
    signal?.throwIfAborted();
    const limit = input.limit ?? 25;
    if (!input.targetWorkspaceId.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("请选择有效企业工作区，账号每页数量须为 1–50");
    const value = await rpc<unknown>("ops.customer-delivery.accounts.list", {
      target_workspace_id: input.targetWorkspaceId,
      ...(input.search?.trim() ? { search: input.search.trim() } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: String(limit),
    }, { signal });
    signal?.throwIfAborted();
    return parseCustomerDeliveryAccounts(value, input.targetWorkspaceId);
  },
  async bindAccount(input, signal) {
    signal?.throwIfAborted();
    if (!input.targetWorkspaceId.trim() || !input.deliveryId.trim() || !input.targetAccountId.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("生效账号关联参数无效，请刷新档案后重试");
    const reason = input.reason.trim();
    if (Array.from(reason).length < 3 || reason.length > 1000) throw new Error("请填写 3–1000 字的关联原因");
    const value = await rpc<unknown>("ops.customer-delivery.account.bind", {
      target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId,
      target_account_id: input.targetAccountId, expected_revision: String(input.expectedRevision), reason,
    }, { signal });
    signal?.throwIfAborted();
    const record = parseRecord(value);
    if (record.id !== input.deliveryId || record.targetAccountId !== input.targetAccountId || !Number.isSafeInteger(record.revision) || Number(record.revision) <= input.expectedRevision) throw new Error("生效账号关联返回了不匹配的记录，请刷新档案核对，不要重复关联");
    if (object(value) && value.workspaceId !== input.targetWorkspaceId) throw new Error("生效账号关联返回了其他企业的记录，请刷新档案核对");
    return record;
  },
  async uploadAsset(input, signal) {
    signal?.throwIfAborted();
    if (("sourceUrl" in input) === ("file" in input)) throw new Error("请选择文件上传或合同链接导入，不能同时提交两种来源");
    if ("sourceUrl" in input) {
      if (input.purpose !== "contract" || typeof input.sourceUrl !== "string") throw new Error("仅合同凭证支持链接导入");
      const sourceUrl = validateCustomerDeliveryContractUrl(input.sourceUrl);
      const value = await rpc<unknown>("ops.customer-delivery.assets.upload", {
        target_workspace_id: input.targetWorkspaceId,
        delivery_id: input.deliveryId,
        purpose: "contract",
        source_url: sourceUrl,
      }, { signal, timeoutMs: 120_000 });
      signal?.throwIfAborted();
      return parseCustomerDeliveryAsset(value);
    }
    const file = await readCustomerDeliveryFile(input.file, input.purpose, signal);
    const value = await rpc<unknown>("ops.customer-delivery.assets.upload", {
      target_workspace_id: input.targetWorkspaceId,
      delivery_id: input.deliveryId,
      purpose: input.purpose,
      name: file.name,
      mime_type: file.mimeType,
      content_base64: file.contentBase64,
      sha256: file.sha256,
    }, { signal, timeoutMs: 120_000 });
    return parseCustomerDeliveryAsset(value);
  },
  async getAsset(input, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.assets.get", {
      target_workspace_id: input.targetWorkspaceId,
      delivery_id: input.deliveryId,
      purpose: input.purpose,
      asset_ref: input.assetRef,
    }, { signal });
    const asset = parseCustomerDeliveryAsset(value);
    if (asset.assetRef !== input.assetRef) throw new Error("安全检查返回了其他素材，请重新检查当前文件");
    return asset;
  },
  async list(input, signal) {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    if (!input.targetWorkspaceId.trim() || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("请选择有效企业工作区，分页参数须在允许范围内");
    const value = await rpc<unknown>("ops.customer-delivery.list", { target_workspace_id: input.targetWorkspaceId,
      ...(input.query?.trim() ? { query: input.query.trim() } : {}),
      ...(input.projectOwner?.trim() ? { project_owner: input.projectOwner.trim() } : {}),
      ...(input.supportOwner?.trim() ? { support_owner: input.supportOwner.trim() } : {}),
      offset: String(offset), limit: String(limit) }, { signal });
    return value === null ? null : parseCustomerDeliveryList(value);
  },
  async get(targetWorkspaceId, deliveryId, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.get", { target_workspace_id: targetWorkspaceId, delivery_id: deliveryId }, { signal });
    if (value === null) throw new Error("客户交付详情接口未返回记录");
    return parseRecord(value);
  },
  async create(targetWorkspaceId, companyName, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.create", { target_workspace_id: targetWorkspaceId, company_name: companyName.trim() }, { signal });
    if (value === null) throw new Error("客户交付创建接口未返回记录");
    return parseRecord(value);
  },
  async update(input, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.update", { target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId, expected_revision: String(input.expectedRevision), patch_json: JSON.stringify(input.patch) }, { signal });
    if (value === null) throw new Error("客户交付更新接口未返回记录");
    return parseRecord(value);
  },
  async updateChecklist(input, signal) {
    // A full delivery checklist verifies every evidence binding in one
    // transaction. Keep the client window aligned with scanned uploads so a
    // valid commit is not surfaced to the operator as an unknown timeout.
    const value = await rpc<unknown>("ops.customer-delivery.checklist.update", buildChecklistUpdateParams(input), { signal, timeoutMs: 120_000 });
    if (value === null) throw new Error("客户交付清单保存接口未返回结果");
    return { items: parseCustomerDeliveryChecklistItems(value), revision: object(value) && typeof value.revision === "number" ? value.revision : undefined };
  },
  async listChecklistItems(input, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.checklist-items.list", { target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId, checklist_key: input.checklistKey }, { signal });
    if (value === null) throw new Error("客户交付清单读取接口未返回结果");
    return parseCustomerDeliveryChecklistItems(value);
  },
  async updateChecklistItem(input, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.checklist-item.update", {
      target_workspace_id: input.targetWorkspaceId,
      delivery_id: input.deliveryId,
      checklist_key: input.checklistKey,
      item_key: input.itemKey,
      completed: String(input.completed),
      ...(input.evidence ? { evidence_json: JSON.stringify(input.evidence) } : {}),
      expected_revision: String(input.expectedRevision),
    }, { signal });
    if (value === null) throw new Error("客户交付清单项保存接口未返回结果");
    const item = parseCustomerDeliveryChecklistItems({ items: [value] })[0];
    if (!item) throw new Error("客户交付清单项保存接口返回了空结果");
    return item;
  },
  async completeTraining(input, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.training.complete", { target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId, completed: String(input.completed), evidence_refs_json: JSON.stringify(parseCustomerDeliveryEvidenceRefs(input.evidenceAssetRefs, "培训凭证")), expected_revision: String(input.expectedRevision) }, { signal });
    if (value === null) throw new Error("客户培训保存接口未返回记录");
    return parseRecord(value);
  },
  async listVideos(targetWorkspaceId, deliveryId, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.videos.list", { target_workspace_id: targetWorkspaceId, delivery_id: deliveryId }, { signal });
    return parseCustomerDeliveryVideos(value);
  },
  async addVideo(input, signal) {
    return rpc("ops.customer-delivery.videos.add", { target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId, title: input.title, asset_ref: input.assetRef, sort_order: String(input.sortOrder ?? 0) }, { signal });
  },
  async downloadAsset(input, signal) {
    const connection = readOpsConnectionConfig();
    const headers: Record<string, string> = { "x-ops-workbench": connection.workbench };
    if (!managedOpsSession) {
      if (connection.actorId) headers["x-actor-id"] = connection.actorId;
      if (connection.token) headers.authorization = `Bearer ${connection.token}`;
    }
    const response = await fetch(`${opsApiBase()}/v1/ops/customer-deliveries/workspaces/${encodeURIComponent(input.targetWorkspaceId)}/${encodeURIComponent(input.deliveryId)}/assets/${encodeURIComponent(input.assetRef)}/download?purpose=${encodeURIComponent(input.purpose)}`, {
      credentials: "include",
      headers,
      signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: unknown }; data?: { error?: { message?: unknown } } } | null;
      const detail = body?.error?.message ?? body?.data?.error?.message;
      throw new Error(typeof detail === "string" && detail.trim() ? detail : `文件读取失败（HTTP ${response.status}）`);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
    const plain = /filename="?([^";]+)"?/iu.exec(disposition)?.[1];
    const fileName = encoded ? decodeURIComponent(encoded) : plain || input.assetRef;
    return { blob: await response.blob(), fileName };
  },
};
