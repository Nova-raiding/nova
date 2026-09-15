import { rpc } from "./opsClient.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";

export interface CustomerDeliveryClient {
  uploadAsset(input: { targetWorkspaceId: string; deliveryId: string; purpose: CustomerDeliveryAssetPurpose; file: File }, signal?: AbortSignal): Promise<CustomerDeliveryAsset>;
  getAsset(input: { targetWorkspaceId: string; deliveryId: string; purpose: CustomerDeliveryAssetPurpose; assetRef: string }, signal?: AbortSignal): Promise<CustomerDeliveryAsset>;
  list(targetWorkspaceId: string, signal?: AbortSignal): Promise<CustomerDeliveryRecord[] | null>;
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
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const bool = (value: unknown): value is boolean => typeof value === "boolean";

export type CustomerDeliveryAssetPurpose = "contract" | "video";
export interface CustomerDeliveryAsset {
  assetRef: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: "pending" | "clean" | "blocked";
  ready: boolean;
}
export const CUSTOMER_DELIVERY_MAX_FILE_BYTES = 50 * 1024 * 1024;
const deliveryFileTypes: Record<CustomerDeliveryAssetPurpose, Record<string, string>> = {
  contract: { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
  video: { mp4: "video/mp4", webm: "video/webm" },
};

export function validateCustomerDeliveryFile(file: Pick<File, "name" | "size" | "type">, purpose: CustomerDeliveryAssetPurpose): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = deliveryFileTypes[purpose][extension];
  if (!mimeType) throw new Error(purpose === "contract" ? "合同仅支持 PDF、DOCX、PNG、JPG、JPEG 文件" : "交付视频仅支持 MP4、WebM 文件");
  if (!file.name.trim() || /[\u0000-\u001f/\\]/u.test(file.name)) throw new Error("文件名无效，请重命名后重试");
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("不能上传空文件");
  if (file.size > CUSTOMER_DELIVERY_MAX_FILE_BYTES) throw new Error("单个文件不能超过 50 MiB");
  const declaredType = file.type.toLowerCase();
  if (declaredType && declaredType !== "application/octet-stream" && declaredType !== mimeType && !(mimeType === "image/jpeg" && declaredType === "image/jpg")) throw new Error("文件类型与扩展名不一致，请检查文件后重试");
  return mimeType;
}

export function parseCustomerDeliveryAsset(value: unknown): CustomerDeliveryAsset {
  if (!object(value) || !text(value.assetRef) || !/^asset[:_]\S+$/u.test(value.assetRef) || !text(value.name) || !value.name.trim() || !text(value.mimeType) || !value.mimeType.trim() || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0 || Number(value.sizeBytes) > CUSTOMER_DELIVERY_MAX_FILE_BYTES || !["pending", "clean", "blocked"].includes(String(value.scanStatus)) || !bool(value.ready) || (value.ready && value.scanStatus !== "clean")) {
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

export interface CustomerDeliveryChecklistItem { itemKey: string; completed: boolean; evidence: string }

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
  const rows = parseCustomerDeliveryList({ items: [value] });
  const row = rows[0];
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
export function parseCustomerDeliveryList(value: unknown): CustomerDeliveryRecord[] {
  const rows = Array.isArray(value) ? value : object(value) && Array.isArray(value.items) ? value.items : null;
  if (!rows) throw new Error("客户交付接口返回了无效响应（items）");
  return rows.map((row, index) => {
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
      ...(Array.isArray(row.integrationItems) ? { integrationItems: row.integrationItems.filter(text) } : {}),
      ...(Array.isArray(row.acceptanceItems) ? { acceptanceItems: row.acceptanceItems.filter(text) } : {}),
      ...(object(row.integrationEvidence) ? { integrationEvidence: Object.fromEntries(Object.entries(row.integrationEvidence).filter(([,v]) => text(v)).map(([k,v]) => [k, String(v)])) } : {}),
      ...(object(row.acceptanceEvidence) ? { acceptanceEvidence: Object.fromEntries(Object.entries(row.acceptanceEvidence).filter(([,v]) => text(v)).map(([k,v]) => [k, String(v)])) } : {}),
    };
  });
}

export const customerDeliveryClient: CustomerDeliveryClient = {
  async uploadAsset(input, signal) {
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
  async list(targetWorkspaceId, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.list", { target_workspace_id: targetWorkspaceId }, { signal });
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
};
