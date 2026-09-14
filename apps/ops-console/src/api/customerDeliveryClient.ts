import { rpc } from "./opsClient.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";

export interface CustomerDeliveryClient {
  list(targetWorkspaceId: string, signal?: AbortSignal): Promise<CustomerDeliveryRecord[] | null>;
  create(targetWorkspaceId: string, companyName: string, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  update(input: { targetWorkspaceId: string; deliveryId: string; patch: Record<string, unknown>; expectedRevision: number }, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  updateChecklist(input: {
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    items: Array<{ itemKey: string; completed: boolean; evidence: string }>;
    expectedRevision: number;
    targetWorkspaceId: string;
  }, signal?: AbortSignal): Promise<{ items: CustomerDeliveryChecklistItem[]; revision?: number }>;
  listChecklistItems(input: { targetWorkspaceId: string; deliveryId: string; checklistKey: "system_integration" | "functional_acceptance" }, signal?: AbortSignal): Promise<CustomerDeliveryChecklistItem[]>;
  completeTraining(input: { targetWorkspaceId: string; deliveryId: string; completed: boolean; expectedRevision: number }, signal?: AbortSignal): Promise<CustomerDeliveryRecord>;
  listVideos(targetWorkspaceId: string, deliveryId: string, signal?: AbortSignal): Promise<Array<{ id: string; title: string; assetRef: string; sortOrder: number }>>;
  addVideo(input: { targetWorkspaceId: string; deliveryId: string; title: string; assetRef: string; sortOrder?: number }, signal?: AbortSignal): Promise<unknown>;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const bool = (value: unknown): value is boolean => typeof value === "boolean";

export interface CustomerDeliveryChecklistItem { itemKey: string; completed: boolean; evidence: string }

function parseRecord(value: unknown): CustomerDeliveryRecord {
  const rows = parseCustomerDeliveryList({ items: [value] });
  const row = rows[0];
  if (!row) throw new Error("客户交付接口返回了空记录");
  return row;
}

function parseChecklistItems(value: unknown): CustomerDeliveryChecklistItem[] {
  const rows = object(value) && Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : null;
  if (!rows) throw new Error("客户交付接口返回了无效清单响应");
  return rows.map((item, index) => {
    if (!object(item) || !text(item.itemKey ?? item.item_key) || typeof item.completed !== "boolean") throw new Error(`客户交付清单响应无效（第 ${index + 1} 项）`);
    const rawEvidence = item.evidence ?? item.evidence_json;
    const evidence = typeof rawEvidence === "string" ? rawEvidence : object(rawEvidence) ? (typeof rawEvidence.note === "string" ? rawEvidence.note : JSON.stringify(rawEvidence)) : "";
    return { itemKey: String(item.itemKey ?? item.item_key), completed: item.completed, evidence };
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
  async list(targetWorkspaceId, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.list", { target_workspace_id: targetWorkspaceId }, { signal });
    return value === null ? null : parseCustomerDeliveryList(value);
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
    const value = await rpc<unknown>("ops.customer-delivery.checklist.update", {
      delivery_id: input.deliveryId,
      target_workspace_id: input.targetWorkspaceId,
      checklist_key: input.checklistKey,
      items_json: JSON.stringify(input.items),
      // Keep the aggregate flag for backwards-compatible servers. The server
      // must still validate and persist each item from items_json.
      completed: String(input.items.length > 0 && input.items.every((item) => item.completed)),
      expected_revision: String(input.expectedRevision),
    }, { signal });
    if (value === null) throw new Error("客户交付清单保存接口未返回结果");
    return { items: parseChecklistItems(value), revision: object(value) && typeof value.revision === "number" ? value.revision : undefined };
  },
  async listChecklistItems(input, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.checklist-items.list", { target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId, checklist_key: input.checklistKey }, { signal });
    if (value === null) throw new Error("客户交付清单读取接口未返回结果");
    return parseChecklistItems(value);
  },
  async completeTraining(input, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.training.complete", { target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId, completed: String(input.completed), expected_revision: String(input.expectedRevision) }, { signal });
    if (value === null) throw new Error("客户培训保存接口未返回记录");
    return parseRecord(value);
  },
  async listVideos(targetWorkspaceId, deliveryId, signal) {
    const value = await rpc<unknown>("ops.customer-delivery.videos.list", { target_workspace_id: targetWorkspaceId, delivery_id: deliveryId }, { signal });
    const rows = object(value) && Array.isArray(value.items) ? value.items : [];
    return rows.map((row, index) => {
      if (!object(row) || !text(row.id) || !text(row.title) || !text(row.assetRef ?? row.asset_ref)) throw new Error(`客户交付视频响应无效（第 ${index + 1} 项）`);
      const sortOrder = Number(row.sortOrder ?? row.sort_order ?? 0);
      if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error(`客户交付视频排序字段无效（第 ${index + 1} 项）`);
      return { id: row.id, title: row.title, assetRef: String(row.assetRef ?? row.asset_ref), sortOrder };
    });
  },
  async addVideo(input, signal) {
    return rpc("ops.customer-delivery.videos.add", { target_workspace_id: input.targetWorkspaceId, delivery_id: input.deliveryId, title: input.title, asset_ref: input.assetRef, sort_order: String(input.sortOrder ?? 0) }, { signal });
  },
};
