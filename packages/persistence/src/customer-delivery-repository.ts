import { randomUUID } from "node:crypto";
import {
  requireWorkspaceScope,
  type SqlClient,
  type SqlPool,
  withWorkspaceTransaction,
} from "./repository.js";

export type DeliveryStatus = "draft" | "active";
export type DeliveryChecklistKey =
  | "customer_profile"
  | "system_integration"
  | "functional_acceptance"
  | "training";
export interface CustomerDeliveryChecklistItem {
  workspaceId: string;
  deliveryId: string;
  checklistKey: "system_integration" | "functional_acceptance";
  itemKey: string;
  completed: boolean;
  evidence: Record<string, unknown>;
  completedByActorId: string | null;
  completedAt: string | null;
  revision: number;
  updatedAt: string;
}
export interface CustomerDeliveryVideo {
  id: string;
  workspaceId: string;
  deliveryId: string;
  title: string;
  assetRef: string;
  sortOrder: number;
  uploadedByActorId: string;
  createdAt: string;
  deletedAt: string | null;
}
export interface CustomerDelivery {
  id: string;
  workspaceId: string;
  companyName: string;
  contractNumber: string | null;
  paymentStatus: "unpaid" | "paid";
  contractRef: string | null;
  projectOwner: string | null;
  supportOwner: string | null;
  paymentDate: string | null;
  paymentEvidenceRefs: string[];
  plannedGoLiveAt: string | null;
  customerProfileStatus: "incomplete" | "complete";
  systemIntegrationStatus: "incomplete" | "complete";
  functionalAcceptanceStatus: "incomplete" | "complete";
  trainingCompleted: boolean;
  trainingEvidenceRefs: string[];
  effectiveAt: string | null;
  revision: number;
  createdByActorId: string;
  updatedByActorId: string;
  archivedAt?: string | null;
  archivedByActorId?: string | null;
  createdAt: string;
  updatedAt: string;
  videos: CustomerDeliveryVideo[];
}
export interface CustomerDeliveryAuditEvent {
  workspaceId: string;
  actorId: string;
  action: string;
  resourceId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  evidence?: Record<string, unknown>;
}
export interface CustomerDeliveryChecklistBatchItem {
  itemKey: string;
  completed: boolean;
  evidence?: Record<string, unknown>;
}
export type CustomerDeliveryPatch = Partial<Pick<CustomerDelivery,
  | "companyName" | "contractNumber" | "paymentStatus" | "contractRef"
  | "projectOwner" | "supportOwner" | "paymentDate" | "paymentEvidenceRefs"
  | "plannedGoLiveAt" | "customerProfileStatus" | "trainingCompleted" | "trainingEvidenceRefs"
  | "archivedAt"
>>;
export const CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS = {
  system_integration: [
    "插件账号",
    "店铺连接",
    "商品扫描",
    "知识库",
    "平台规则",
    "创意点数",
    "企业信息",
    "品牌资产",
    "商品资料",
    "客户偏好",
  ],
  functional_acceptance: [
    "文案生成",
    "图片生成",
    "标注编辑",
    "自动检查",
    "视频生成",
    "店铺/商品读取",
    "技术验收",
    "内容验收",
  ],
} as const;
export interface CustomerDeliveryRepository {
  list(workspaceId: string): Promise<CustomerDelivery[]>;
  get(workspaceId: string, id: string): Promise<CustomerDelivery | null>;
  create(input: {
    workspaceId: string;
    companyName: string;
    actorId: string;
  }): Promise<CustomerDelivery>;
  update(input: {
    workspaceId: string;
    id: string;
    actorId: string;
    expectedRevision: number;
    patch: CustomerDeliveryPatch;
  }): Promise<CustomerDelivery>;
  listChecklistItems?(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
  }): Promise<CustomerDeliveryChecklistItem[]>;
  updateChecklistItem?(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    itemKey: string;
    completed: boolean;
    evidence?: Record<string, unknown>;
    actorId: string;
    expectedRevision: number;
  }): Promise<CustomerDeliveryChecklistItem>;
  updateChecklistItems?(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    items: CustomerDeliveryChecklistBatchItem[];
    actorId: string;
    expectedRevision: number;
  }): Promise<CustomerDeliveryChecklistItem[]>;
  addVideo(input: {
    workspaceId: string;
    deliveryId: string;
    actorId: string;
    title: string;
    assetRef: string;
    sortOrder?: number;
  }): Promise<CustomerDeliveryVideo>;
  removeVideo?(input: {
    workspaceId: string;
    deliveryId: string;
    videoId: string;
    actorId: string;
  }): Promise<void>;
}
export class CustomerDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const clone = <T>(v: T): T => structuredClone(v);
export function customerDeliveryEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(ref => typeof ref !== "string" || !ref.trim())) return [];
  return [...new Set(value.map((ref: string) => ref.trim()))];
}
function normalizeDeliveryPatch(input: CustomerDeliveryPatch): CustomerDeliveryPatch {
  if ("systemIntegrationStatus" in input || "functionalAcceptanceStatus" in input)
    throw new CustomerDeliveryError("INVALID_INPUT", "清单汇总状态只能由真实清单项推导");
  const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as CustomerDeliveryPatch;
  if (typeof patch.contractRef === "string") patch.contractRef = patch.contractRef.trim();
  for (const key of ["paymentEvidenceRefs", "trainingEvidenceRefs"] as const) {
    if (patch[key] === undefined) continue;
    if (!Array.isArray(patch[key]) || patch[key]!.some(ref => typeof ref !== "string" || !ref.trim()))
      throw new CustomerDeliveryError("INVALID_INPUT", "凭证必须是非空字符串组成的数组");
    patch[key] = customerDeliveryEvidenceRefs(patch[key]);
  }
  return patch;
}
function normalizeChecklistEvidence(evidence: Record<string, unknown> | undefined) {
  if (!evidence || !Array.isArray(evidence.asset_refs)) return evidence;
  // Use the same reference identity for validation, persistence, and the
  // database's exact-match evidence invalidation trigger. Leave other evidence
  // fields untouched; existing validation still rejects invalid completed refs.
  return { ...evidence, asset_refs: evidence.asset_refs.map(ref => typeof ref === "string" ? ref.trim() : ref) };
}
/** Contract completion evidence must be a platform asset reference.
 * External URLs are not proof of upload, binding, or a clean scanner verdict. */
export function isValidCustomerDeliveryContractRef(value: string | null | undefined): boolean {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!ref) return false;
  return /^(?:asset:\/\/|asset_ref[:_]|asset[:_])[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(ref);
}
function checklistComplete(checklistKey: "system_integration" | "functional_acceptance", items: readonly CustomerDeliveryChecklistItem[]) {
  return CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey].every(itemKey => {
    const matches = items.filter(item => item.checklistKey === checklistKey && item.itemKey === itemKey);
    return matches.length === 1 && matches[0]!.completed;
  });
}
const complete = (d: CustomerDelivery, items: readonly CustomerDeliveryChecklistItem[]) =>
  d.paymentStatus === "paid" &&
  Boolean(d.paymentDate) &&
  d.customerProfileStatus === "complete" &&
  Boolean(d.contractNumber?.trim() && d.projectOwner?.trim() && d.supportOwner?.trim() && d.plannedGoLiveAt) &&
  isValidCustomerDeliveryContractRef(d.contractRef) &&
  d.systemIntegrationStatus === "complete" &&
  d.functionalAcceptanceStatus === "complete" &&
  d.trainingCompleted &&
  (["system_integration", "functional_acceptance"] as const).every(checklistKey =>
    checklistComplete(checklistKey, items.filter(item => item.workspaceId === d.workspaceId && item.deliveryId === d.id))) &&
  d.videos.some((video) => !video.deletedAt);
export class MemoryCustomerDeliveryRepository implements CustomerDeliveryRepository {
  private rows = new Map<string, CustomerDelivery>();
  private items = new Map<string, CustomerDeliveryChecklistItem>();
  constructor(
    private readonly auditWriter: (
      event: CustomerDeliveryAuditEvent,
    ) => Promise<void> | void = () => {},
  ) {}
  private isComplete(delivery: CustomerDelivery) {
    return complete(delivery, [...this.items.values()]);
  }
  private readable(delivery: CustomerDelivery) {
    const result = clone(delivery);
    if (!this.isComplete(delivery)) result.effectiveAt = null;
    return result;
  }
  async list(workspaceId: string) {
    const s = requireWorkspaceScope(workspaceId);
    return [...this.rows.values()]
      .filter((x) => x.workspaceId === s && !x.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(row => this.readable(row));
  }
  async get(workspaceId: string, id: string) {
    const r = this.rows.get(`${requireWorkspaceScope(workspaceId)}:${id}`);
    return r ? this.readable(r) : null;
  }
  async create(input: {
    workspaceId: string;
    companyName: string;
    actorId: string;
  }) {
    const ws = requireWorkspaceScope(input.workspaceId);
    if (!input.companyName?.trim())
      throw new CustomerDeliveryError("INVALID_INPUT", "companyName required");
    if (
      [...this.rows.values()].some(
        (x) =>
          x.workspaceId === ws &&
          !x.archivedAt &&
          x.companyName.toLowerCase() ===
            input.companyName.trim().toLowerCase(),
      )
    )
      throw new CustomerDeliveryError(
        "DUPLICATE_COMPANY",
        "company already exists",
      );
    const now = new Date().toISOString();
    const d: CustomerDelivery = {
      id: `cd_${randomUUID()}`,
      workspaceId: ws,
      companyName: input.companyName.trim(),
      contractNumber: null,
      paymentStatus: "unpaid",
      contractRef: null,
      projectOwner: null,
      supportOwner: null,
      paymentDate: null,
      paymentEvidenceRefs: [],
      plannedGoLiveAt: null,
      customerProfileStatus: "incomplete",
      systemIntegrationStatus: "incomplete",
      functionalAcceptanceStatus: "incomplete",
      trainingCompleted: false,
      trainingEvidenceRefs: [],
      effectiveAt: null,
      revision: 1,
      createdByActorId: input.actorId,
      updatedByActorId: input.actorId,
      archivedAt: null,
      archivedByActorId: null,
      createdAt: now,
      updatedAt: now,
      videos: [],
    };
    this.rows.set(`${ws}:${d.id}`, d);
    await this.auditWriter({
      workspaceId: ws,
      actorId: input.actorId,
      action: "customer_delivery.create",
      resourceId: d.id,
      before: {},
      after: clone(d) as unknown as Record<string, unknown>,
      reason: "创建客户交付档案",
      evidence: { companyName: d.companyName },
    });
    return clone(d);
  }
  async update(input: {
    workspaceId: string;
    id: string;
    actorId: string;
    expectedRevision: number;
    patch: CustomerDeliveryPatch;
  }) {
    const patch = normalizeDeliveryPatch(input.patch);
    const ws = requireWorkspaceScope(input.workspaceId),
      d = this.rows.get(`${ws}:${input.id}`);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    if (d.revision !== input.expectedRevision)
      throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
    if (Object.keys(patch).length === 0) return this.readable(d);
    const candidate = { ...d, ...patch };
    if (
      input.patch.companyName !== undefined &&
      !input.patch.companyName.trim()
    )
      throw new CustomerDeliveryError("INVALID_INPUT", "companyName required");
    const before = clone(d);
    if ("contractRef" in patch && patch.contractRef != null && !isValidCustomerDeliveryContractRef(patch.contractRef))
      throw new CustomerDeliveryError("INVALID_INPUT", "合同必须是已上传并扫描通过的 asset_ref");
    if (patch.customerProfileStatus === "complete" || (d.customerProfileStatus === "complete" && patch.customerProfileStatus !== "incomplete")) {
      if (
        !candidate.contractNumber?.trim() ||
        !isValidCustomerDeliveryContractRef(candidate.contractRef) ||
        !candidate.projectOwner?.trim() ||
        !candidate.supportOwner?.trim() ||
        (candidate.paymentStatus === "paid" && !candidate.paymentDate) ||
        !candidate.plannedGoLiveAt
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "客户档案字段未填写完整",
        );
    }
    Object.assign(d, patch);
    if (patch.archivedAt !== undefined) d.archivedByActorId = patch.archivedAt ? input.actorId : null;
    d.updatedByActorId = input.actorId;
    d.updatedAt = new Date().toISOString();
    d.revision++;
    d.effectiveAt = this.isComplete(d) ? (d.effectiveAt ?? d.updatedAt) : null;
    await this.auditWriter({
      workspaceId: ws,
      actorId: input.actorId,
      action: "customer_delivery.update",
      resourceId: d.id,
      before: before as unknown as Record<string, unknown>,
      after: clone(d) as unknown as Record<string, unknown>,
      reason: "更新客户交付档案",
      evidence: { patch, revision: d.revision },
    });
    return clone(d);
  }
  async listChecklistItems(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
  }) {
    const ws = requireWorkspaceScope(input.workspaceId);
    const d = this.rows.get(`${ws}:${input.deliveryId}`);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    return [...this.items.values()]
      .filter(
        (x) =>
          x.workspaceId === ws &&
          x.deliveryId === d.id &&
          x.checklistKey === input.checklistKey,
      )
      .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
      .map(clone);
  }
  async updateChecklistItem(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    itemKey: string;
    completed: boolean;
    evidence?: Record<string, unknown>;
    actorId: string;
    expectedRevision: number;
  }) {
    input = { ...input, evidence: normalizeChecklistEvidence(input.evidence) };
    const ws = requireWorkspaceScope(input.workspaceId),
      d = this.rows.get(`${ws}:${input.deliveryId}`);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    if (d.revision !== input.expectedRevision)
      throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
    if (!input.itemKey.trim())
      throw new CustomerDeliveryError("INVALID_INPUT", "itemKey required");
    if (
      typeof input.completed !== "boolean" ||
      !CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[input.checklistKey].includes(
        input.itemKey.trim() as never,
      )
    )
      throw new CustomerDeliveryError(
        "INVALID_INPUT",
        "unknown checklist item",
      );
    const key = `${ws}:${d.id}:${input.checklistKey}:${input.itemKey.trim()}`;
    const now = new Date().toISOString();
    const prev = this.items.get(key);
    const item: CustomerDeliveryChecklistItem = {
      workspaceId: ws,
      deliveryId: d.id,
      checklistKey: input.checklistKey,
      itemKey: input.itemKey.trim(),
      completed: input.completed,
      evidence: input.evidence ?? {},
      completedByActorId: input.completed ? input.actorId : null,
      completedAt: input.completed ? now : null,
      revision: (prev?.revision ?? 0) + 1,
      updatedAt: now,
    };
    this.items.set(key, item);
    d.revision++;
    d.updatedAt = now;
    d.updatedByActorId = input.actorId;
    const all = [...this.items.values()].filter(
      (x) =>
        x.workspaceId === ws &&
        x.deliveryId === d.id &&
        x.checklistKey === input.checklistKey,
    );
    const status = checklistComplete(input.checklistKey, all) ? "complete" : "incomplete";
    if (input.checklistKey === "system_integration")
      d.systemIntegrationStatus = status;
    else {
      d.functionalAcceptanceStatus = status;
    }
    if (this.isComplete(d)) d.effectiveAt = d.effectiveAt ?? now;
    else d.effectiveAt = null;
    await this.auditWriter({
      workspaceId: ws,
      actorId: input.actorId,
      action: "customer_delivery.checklist_item.update",
      resourceId: d.id,
      before: prev ? (clone(prev) as any) : {},
      after: clone(item) as any,
      reason: "更新客户交付清单项",
      evidence: { checklistKey: input.checklistKey, itemKey: item.itemKey },
    });
    return clone(item);
  }
  async updateChecklistItems(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    items: CustomerDeliveryChecklistBatchItem[];
    actorId: string;
    expectedRevision: number;
  }) {
    input = { ...input, items: input.items.map(item => ({ ...item, evidence: normalizeChecklistEvidence(item.evidence) })) };
    const ws = requireWorkspaceScope(input.workspaceId),
      d = this.rows.get(`${ws}:${input.deliveryId}`);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    if (d.revision !== input.expectedRevision)
      throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
    const expectedKeys = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[
      input.checklistKey
    ] as readonly string[];
    if (input.items.length !== expectedKeys.length)
      throw new CustomerDeliveryError(
        "INVALID_INPUT",
        `items_json must contain exactly ${expectedKeys.length} items`,
      );
    const seen = new Set<string>();
    for (const x of input.items) {
      const key = x.itemKey?.trim();
      if (
        !key ||
        seen.has(key) ||
        !expectedKeys.includes(key) ||
        typeof x.completed !== "boolean"
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "items_json contains invalid checklist item",
        );
      if (
        x.evidence !== undefined &&
        (x.evidence === null ||
          typeof x.evidence !== "object" ||
          Array.isArray(x.evidence))
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "evidence must be an object",
        );
      seen.add(key);
    }
    const beforeItems = [...this.items.values()].filter(item => item.workspaceId === ws
      && item.deliveryId === d.id && item.checklistKey === input.checklistKey).map(clone);
    const now = new Date().toISOString();
    const result = input.items.map((x) => {
      const itemKey = x.itemKey.trim(),
        key = `${ws}:${d.id}:${input.checklistKey}:${itemKey}`,
        prev = this.items.get(key);
      const item: CustomerDeliveryChecklistItem = {
        workspaceId: ws,
        deliveryId: d.id,
        checklistKey: input.checklistKey,
        itemKey,
        completed: x.completed,
        evidence: x.evidence ?? {},
        completedByActorId: x.completed ? input.actorId : null,
        completedAt: x.completed ? now : null,
        revision: (prev?.revision ?? 0) + 1,
        updatedAt: now,
      };
      this.items.set(key, item);
      return item;
    });
    d.revision++;
    d.updatedAt = now;
    d.updatedByActorId = input.actorId;
    const all = [...this.items.values()].filter(
      (x) =>
        x.workspaceId === ws &&
        x.deliveryId === d.id &&
        x.checklistKey === input.checklistKey,
    );
    const status = checklistComplete(input.checklistKey, all) ? "complete" : "incomplete";
    if (input.checklistKey === "system_integration")
      d.systemIntegrationStatus = status;
    else {
      d.functionalAcceptanceStatus = status;
    }
    d.effectiveAt = this.isComplete(d) ? (d.effectiveAt ?? now) : null;
    await this.auditWriter({
      workspaceId: ws,
      actorId: input.actorId,
      action: "customer_delivery.checklist_items.update",
      resourceId: d.id,
      before: { revision: input.expectedRevision, items: beforeItems },
      after: { revision: d.revision, items: clone(result) },
      reason: "批量更新客户交付清单项",
      evidence: { checklistKey: input.checklistKey, itemCount: result.length },
    });
    return result.map(clone);
  }
  async addVideo(input: {
    workspaceId: string;
    deliveryId: string;
    actorId: string;
    title: string;
    assetRef: string;
    sortOrder?: number;
  }) {
    const d = await this.get(input.workspaceId, input.deliveryId);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    if (!input.title.trim() || !input.assetRef.trim())
      throw new CustomerDeliveryError(
        "INVALID_INPUT",
        "video title and assetRef required",
      );
    const v: CustomerDeliveryVideo = {
      id: `cdv_${randomUUID()}`,
      workspaceId: d.workspaceId,
      deliveryId: d.id,
      title: input.title.trim(),
      assetRef: input.assetRef.trim(),
      sortOrder: input.sortOrder ?? d.videos.length,
      uploadedByActorId: input.actorId,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };
    const row = this.rows.get(`${d.workspaceId}:${d.id}`)!;
    row.videos.push(v);
    row.updatedAt = new Date().toISOString();
    row.updatedByActorId = input.actorId;
    row.revision++;
    row.effectiveAt = this.isComplete(row) ? (row.effectiveAt ?? row.updatedAt) : null;
    await this.auditWriter({
      workspaceId: d.workspaceId,
      actorId: input.actorId,
      action: "customer_delivery.video.add",
      resourceId: v.id,
      before: {},
      after: clone(v) as unknown as Record<string, unknown>,
      reason: "添加客户交付视频",
      evidence: { deliveryId: d.id, assetRef: v.assetRef },
    });
    return clone(v);
  }
  async removeVideo(input: {
    workspaceId: string;
    deliveryId: string;
    videoId: string;
    actorId: string;
  }) {
    const ws = requireWorkspaceScope(input.workspaceId),
      row = this.rows.get(`${ws}:${input.deliveryId}`),
      video = row?.videos.find((v) => v.id === input.videoId);
    if (!row || !video)
      throw new CustomerDeliveryError("NOT_FOUND", "video not found");
    if (video.deletedAt) return;
    const before = clone(video);
    video.deletedAt = new Date().toISOString();
    row.updatedAt = video.deletedAt;
    row.updatedByActorId = input.actorId;
    row.revision++;
    row.effectiveAt = this.isComplete(row) ? (row.effectiveAt ?? row.updatedAt) : null;
    await this.auditWriter({
      workspaceId: ws,
      actorId: input.actorId,
      action: "customer_delivery.video.remove",
      resourceId: video.id,
      before: before as unknown as Record<string, unknown>,
      after: clone(video) as unknown as Record<string, unknown>,
      reason: "移除客户交付视频（软删除）",
      evidence: { deliveryId: row.id, softDelete: true },
    });
  }
}
type DeliveryEvidencePurpose = "contract" | "payment" | "system_integration" | "functional_acceptance" | "training" | "video";
type DeliveryEvidenceMutation =
  | { kind: "update"; expectedRevision: number; patch: CustomerDeliveryPatch }
  | { kind: "item"; expectedRevision: number; checklistKey: "system_integration" | "functional_acceptance"; itemKey: string; completed: boolean; evidence?: Record<string, unknown> }
  | { kind: "batch"; expectedRevision: number; checklistKey: "system_integration" | "functional_acceptance"; items: CustomerDeliveryChecklistBatchItem[] }
  | { kind: "add_video"; assetRef: string }
  | { kind: "remove_video"; videoId: string };
class DeliveryEvidenceSnapshotChanged extends Error {}

export class PostgresCustomerDeliveryRepository implements CustomerDeliveryRepository {
  // A presence check in this map also prevents a late assertion from acquiring
  // another asset lock while the transaction already holds its delivery lock.
  private readonly evidenceLocks = new WeakMap<object, Set<string>>();
  constructor(private readonly pool: SqlPool) {}
  private async assertEvidenceAssets(
    c: any,
    workspaceId: string,
    deliveryId: string,
    purpose: DeliveryEvidencePurpose,
    assetRefs: readonly string[],
  ) {
    for (const assetRef of customerDeliveryEvidenceRefs(assetRefs)) {
      const locked = this.evidenceLocks.get(c);
      if (locked) {
        if (!locked.has(JSON.stringify([workspaceId, deliveryId, purpose, assetRef])))
          throw new CustomerDeliveryError("REVISION_CONFLICT", "delivery evidence changed after preflight");
        continue;
      }
      await c.query(
        `SELECT public.assert_customer_delivery_evidence_asset($1,$2,$3,$4)`,
        [workspaceId, deliveryId, purpose, assetRef],
      );
    }
  }
  private evidenceForMutation(delivery: CustomerDelivery, persistedItems: CustomerDeliveryChecklistItem[], mutation: DeliveryEvidenceMutation) {
    const candidate = clone(delivery);
    let items = clone(persistedItems);
    const evidence = new Map<string, { purpose: DeliveryEvidencePurpose; assetRef: string }>();
    const add = (purpose: DeliveryEvidencePurpose, refs: readonly string[]) => {
      for (const assetRef of customerDeliveryEvidenceRefs(refs))
        evidence.set(JSON.stringify([purpose, assetRef]), { purpose, assetRef });
    };
    if (mutation.kind === "update") {
      const p = mutation.patch;
      Object.assign(candidate, p);
      if ("contractRef" in p && p.contractRef != null && !isValidCustomerDeliveryContractRef(p.contractRef))
        throw new CustomerDeliveryError("INVALID_INPUT", "合同必须是已上传并扫描通过的 asset_ref");
      if ((Object.hasOwn(p, "contractRef") || p.customerProfileStatus === "complete")
        && candidate.contractRef)
        add("contract", [candidate.contractRef]);
      if (Object.hasOwn(p, "paymentEvidenceRefs")
        || ((Object.hasOwn(p, "paymentStatus") || Object.hasOwn(p, "paymentDate")) && candidate.paymentStatus === "paid"))
        add("payment", candidate.paymentEvidenceRefs);
      if (Object.hasOwn(p, "trainingEvidenceRefs")
        || (Object.hasOwn(p, "trainingCompleted") && candidate.trainingCompleted))
        add("training", candidate.trainingEvidenceRefs);
    } else if (mutation.kind === "item" || mutation.kind === "batch") {
      const changes = mutation.kind === "item" ? [mutation] : mutation.items;
      for (const change of changes) {
        const itemKey = change.itemKey.trim();
        items = items.filter(item => item.checklistKey !== mutation.checklistKey || item.itemKey !== itemKey);
        items.push({ workspaceId: candidate.workspaceId, deliveryId: candidate.id, checklistKey: mutation.checklistKey,
          itemKey, completed: change.completed, evidence: change.evidence ?? {}, completedByActorId: null,
          completedAt: null, revision: 0, updatedAt: candidate.updatedAt });
        add(mutation.checklistKey, customerDeliveryEvidenceRefs(change.evidence?.asset_refs));
      }
      const status = checklistComplete(mutation.checklistKey, items) ? "complete" : "incomplete";
      if (mutation.checklistKey === "system_integration") candidate.systemIntegrationStatus = status;
      else candidate.functionalAcceptanceStatus = status;
    } else if (mutation.kind === "add_video") {
      add("video", [mutation.assetRef]);
      candidate.videos.push({ id: "preflight-video", workspaceId: candidate.workspaceId, deliveryId: candidate.id,
        title: "preflight", assetRef: mutation.assetRef, sortOrder: 0, uploadedByActorId: "preflight",
        createdAt: candidate.updatedAt, deletedAt: null });
    } else {
      if (!candidate.videos.some(video => video.id === mutation.videoId))
        throw new CustomerDeliveryError("NOT_FOUND", "video not found");
      candidate.videos = candidate.videos.filter(video => video.id !== mutation.videoId);
    }
    // Incomplete historical records remain repairable: do not validate an old
    // reference unless this operation attaches it or would make the row ready.
    if (complete(candidate, items)) {
      if (candidate.contractRef) add("contract", [candidate.contractRef]);
      add("payment", candidate.paymentEvidenceRefs);
      add("training", candidate.trainingEvidenceRefs);
      for (const item of items) if (item.completed) add(item.checklistKey, customerDeliveryEvidenceRefs(item.evidence?.asset_refs));
      add("video", candidate.videos.filter(video => !video.deletedAt).map(video => video.assetRef));
    }
    return [...evidence.values()].sort((a, b) => a.assetRef < b.assetRef ? -1 : a.assetRef > b.assetRef ? 1
      : a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : 0);
  }
  private async evidenceSnapshot(c: SqlClient, workspaceId: string, deliveryId: string, row: any,
    stage: "preflight" | "recheck" | "read" | "read_recheck") {
    const videos = await c.query(
      `SELECT * FROM workspace_customer_delivery_videos WHERE workspace_id=$1 AND delivery_id=$2 AND deleted_at IS NULL ORDER BY sort_order,id /* delivery_evidence_${stage}_videos */`,
      [workspaceId, deliveryId],
    );
    const items = await c.query(
      `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 /* delivery_evidence_${stage}_items */`,
      [workspaceId, deliveryId],
    );
    return { delivery: this.map(row, videos.rows.map(video => this.mapVideo(video))),
      items: items.rows.map(item => this.mapItem(item)) };
  }
  private evidenceSnapshotKey(snapshot: { delivery: CustomerDelivery; items: CustomerDeliveryChecklistItem[] }) {
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    return JSON.stringify({ delivery: { ...snapshot.delivery,
      videos: [...snapshot.delivery.videos].sort((a, b) => compare(a.id, b.id)) },
      items: [...snapshot.items].sort((a, b) => compare(`${a.checklistKey}:${a.itemKey}`, `${b.checklistKey}:${b.itemKey}`)) });
  }
  private async lockEvidenceParent(c: SqlClient, workspaceId: string, deliveryId: string, mode: "UPDATE" | "SHARE") {
    try {
      // A multi-asset writer may already own this parent after invalidating a
      // different asset. Never wait on it while holding our verified asset locks.
      return await c.query(
        `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 FOR ${mode} NOWAIT /* ${mode === "UPDATE" ? "delivery_evidence_recheck" : "delivery_evidence_read_recheck"} */`,
        [workspaceId, deliveryId],
      );
    } catch (error) {
      // Scope this mapping to the parent-lock statement. An asset assertion or
      // any other SQL failure with the same code must retain its real error.
      if (typeof error === "object" && error !== null && "code" in error && error.code === "55P03")
        throw new CustomerDeliveryError("REVISION_CONFLICT", "delivery is being changed; refresh and retry");
      throw error;
    }
  }
  private async withEvidenceTransaction<T>(workspaceId: string, deliveryId: string, mutation: DeliveryEvidenceMutation, work: (c: SqlClient) => Promise<T>): Promise<T> {
    // Video endpoints have no caller revision. Only a changed pre-read may be
    // retried, and only before any write/audit. Other failures always propagate.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withWorkspaceTransaction(this.pool, workspaceId, async c => {
          const initial = await c.query(
            `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 /* delivery_evidence_preflight_parent */`,
            [workspaceId, deliveryId],
          );
          const row = initial.rows[0];
          if (!row) throw new CustomerDeliveryError("NOT_FOUND", "customer delivery not found");
          if ("expectedRevision" in mutation && Number(row.revision) !== mutation.expectedRevision)
            throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
          const initialSnapshot = await this.evidenceSnapshot(c, workspaceId, deliveryId, row, "preflight");
          const evidence = this.evidenceForMutation(initialSnapshot.delivery, initialSnapshot.items, mutation);
          const locked = new Set<string>();
          // Migration 204's assertion locks assets. Acquire all of them before
          // the parent; its invalidation trigger takes those locks in this order.
          for (const { purpose, assetRef } of evidence) {
            await this.assertEvidenceAssets(c, workspaceId, deliveryId, purpose, [assetRef]);
            locked.add(JSON.stringify([workspaceId, deliveryId, purpose, assetRef]));
          }
          const current = await this.lockEvidenceParent(c, workspaceId, deliveryId, "UPDATE");
          if (!current.rows[0]) throw new CustomerDeliveryError("NOT_FOUND", "customer delivery not found");
          if (Number(current.rows[0].revision) !== Number(row.revision)) throw new DeliveryEvidenceSnapshotChanged("revision changed during evidence preflight");
          const lockedSnapshot = await this.evidenceSnapshot(c, workspaceId, deliveryId, current.rows[0], "recheck");
          if (this.evidenceSnapshotKey(initialSnapshot) !== this.evidenceSnapshotKey(lockedSnapshot))
            throw new DeliveryEvidenceSnapshotChanged("delivery references changed during evidence preflight");
          this.evidenceLocks.set(c, locked);
          try { return await work(c); }
          finally { this.evidenceLocks.delete(c); }
        });
      } catch (error) {
        if (!(error instanceof DeliveryEvidenceSnapshotChanged)) throw error;
        if ("expectedRevision" in mutation || attempt === 2)
          throw new CustomerDeliveryError("REVISION_CONFLICT", "delivery changed during evidence verification; refresh and retry");
      }
    }
    throw new CustomerDeliveryError("REVISION_CONFLICT", "delivery evidence verification changed repeatedly");
  }
  private async readWithEvidence(workspaceId: string, deliveryId: string): Promise<CustomerDelivery | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withWorkspaceTransaction(this.pool, workspaceId, async c => {
          const initial = await c.query(
            `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 /* delivery_evidence_read_parent */`,
            [workspaceId, deliveryId],
          );
          if (!initial.rows[0]) return null;
          const snapshot = await this.evidenceSnapshot(c, workspaceId, deliveryId, initial.rows[0], "read");
          let ready = complete(snapshot.delivery, snapshot.items);
          if (snapshot.delivery.effectiveAt && ready) {
            const evidence = this.evidenceForMutation(snapshot.delivery, snapshot.items,
              { kind: "update", expectedRevision: snapshot.delivery.revision, patch: {} });
            await c.query("SAVEPOINT customer_delivery_read_evidence");
            try {
              for (const { purpose, assetRef } of evidence)
                await this.assertEvidenceAssets(c, workspaceId, deliveryId, purpose, [assetRef]);
            } catch (error) {
              await c.query("ROLLBACK TO SAVEPOINT customer_delivery_read_evidence");
              // Do not turn missing permissions, migrations, or DB outages into
              // apparent business incompleteness. Only this assertion's explicit
              // unavailable-evidence result is a projection downgrade.
              if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "23514"
                || !("message" in error) || error.message !== "customer delivery evidence is unavailable") throw error;
              ready = false;
            }
            await c.query("RELEASE SAVEPOINT customer_delivery_read_evidence");
          }
          const current = await this.lockEvidenceParent(c, workspaceId, deliveryId, "SHARE");
          if (!current.rows[0]) return null;
          if (Number(current.rows[0].revision) !== snapshot.delivery.revision)
            throw new DeliveryEvidenceSnapshotChanged("revision changed during evidence read");
          const locked = await this.evidenceSnapshot(c, workspaceId, deliveryId, current.rows[0], "read_recheck");
          if (this.evidenceSnapshotKey(snapshot) !== this.evidenceSnapshotKey(locked))
            throw new DeliveryEvidenceSnapshotChanged("delivery references changed during evidence read");
          const result = locked.delivery;
          if (!ready) result.effectiveAt = null;
          return result;
        });
      } catch (error) {
        if (!(error instanceof DeliveryEvidenceSnapshotChanged)) throw error;
        if (attempt === 2) throw new CustomerDeliveryError("REVISION_CONFLICT", "delivery changed during evidence read; refresh and retry");
      }
    }
    throw new CustomerDeliveryError("REVISION_CONFLICT", "delivery evidence read changed repeatedly");
  }
  private async audit(
    c: any,
    e: {
      workspaceId: string;
      actorId: string;
      action: string;
      resourceType: string;
      resourceId: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      reason: string;
    },
  ) {
    await c.query(
      `INSERT INTO workspace_operation_audit (id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [
        randomUUID(),
        e.workspaceId,
        e.actorId,
        e.action,
        e.resourceType,
        e.resourceId,
        JSON.stringify(e.before),
        JSON.stringify(e.after),
        e.reason,
      ],
    );
  }
  private map(r: any, videos: CustomerDeliveryVideo[] = []): CustomerDelivery {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      companyName: r.company_name,
      contractNumber: r.contract_number,
      paymentStatus: r.payment_status,
      contractRef: r.contract_ref,
      projectOwner: r.project_owner,
      supportOwner: r.support_owner,
      // pg parses DATE as local midnight, not an instant. Converting that to
      // UTC loses a calendar day in positive-offset server time zones.
      paymentDate: r.payment_date instanceof Date
        ? `${r.payment_date.getFullYear()}-${String(r.payment_date.getMonth() + 1).padStart(2, "0")}-${String(r.payment_date.getDate()).padStart(2, "0")}`
        : r.payment_date ? String(r.payment_date).slice(0, 10) : null,
      paymentEvidenceRefs: customerDeliveryEvidenceRefs(r.payment_evidence_refs),
      plannedGoLiveAt: r.planned_go_live_at
        ? new Date(r.planned_go_live_at).toISOString()
        : null,
      customerProfileStatus: r.customer_profile_status,
      systemIntegrationStatus: r.system_integration_status,
      functionalAcceptanceStatus: r.functional_acceptance_status,
      trainingCompleted: Boolean(r.training_completed),
      trainingEvidenceRefs: customerDeliveryEvidenceRefs(r.training_evidence_refs),
      effectiveAt: r.effective_at
        ? new Date(r.effective_at).toISOString()
        : null,
      revision: Number(r.revision),
      createdByActorId: r.created_by_actor_id,
      updatedByActorId: r.updated_by_actor_id,
      archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
      archivedByActorId: r.archived_by_actor_id ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      videos,
    };
  }
  private mapVideo(r: any): CustomerDeliveryVideo {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      deliveryId: r.delivery_id,
      title: r.title,
      assetRef: r.asset_ref,
      sortOrder: Number(r.sort_order),
      uploadedByActorId: r.uploaded_by_actor_id,
      createdAt: new Date(r.created_at).toISOString(),
      deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
    };
  }
  private mapItem(r: any): CustomerDeliveryChecklistItem {
    return {
      workspaceId: r.workspace_id,
      deliveryId: r.delivery_id,
      checklistKey: r.checklist_key,
      itemKey: r.item_key,
      completed: Boolean(r.completed),
      evidence: r.evidence ?? {},
      completedByActorId: r.completed_by_actor_id ?? null,
      completedAt: r.completed_at
        ? new Date(r.completed_at).toISOString()
        : null,
      revision: Number(r.revision),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }
  private async withVideos(c: any, rows: any[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const v = await c.query(
      `SELECT * FROM workspace_customer_delivery_videos WHERE workspace_id=$1 AND delivery_id = ANY($2::text[]) AND deleted_at IS NULL ORDER BY sort_order,id`,
      [rows[0].workspace_id, ids],
    );
    const by = new Map<string, CustomerDeliveryVideo[]>();
    for (const x of v.rows) {
      const a = by.get(x.delivery_id) || [];
      a.push(this.mapVideo(x));
      by.set(x.delivery_id, a);
    }
    // A historical effective_at is not sufficient evidence of readiness.
    // Only downgrade the read projection; never rewrite historical facts here.
    const candidates = rows.filter(row => row.effective_at);
    const items = candidates.length ? await c.query(
      `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id = ANY($2::text[])`,
      [rows[0].workspace_id, candidates.map(row => row.id)],
    ) : { rows: [] };
    const mappedItems = items.rows.map((item: any) => this.mapItem(item));
    return rows.map((r) => {
      const mapped = this.map(r, by.get(r.id) || []);
      if (mapped.effectiveAt && !complete(mapped, mappedItems)) mapped.effectiveAt = null;
      return mapped;
    });
  }
  private async refreshEffectiveAt(c: any, workspaceId: string, deliveryId: string) {
    // Every managed checklist/video writer takes this same parent lock before
    // changing children, so the complete snapshot remains stable until commit.
    const current = await c.query(
      `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, deliveryId],
    );
    if (!current.rows[0]) throw new CustomerDeliveryError("NOT_FOUND", "customer delivery not found");
    const videos = await c.query(
      `SELECT * FROM workspace_customer_delivery_videos WHERE workspace_id=$1 AND delivery_id=$2 AND deleted_at IS NULL`,
      [workspaceId, deliveryId],
    );
    const items = await c.query(
      `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2`,
      [workspaceId, deliveryId],
    );
    const delivery = this.map(current.rows[0], videos.rows.map((video: any) => this.mapVideo(video)));
    const checklistItems: CustomerDeliveryChecklistItem[] = items.rows.map((item: any) => this.mapItem(item));
    const ready = complete(delivery, checklistItems);
    if (ready) {
      if (delivery.contractRef)
        await this.assertEvidenceAssets(c, workspaceId, deliveryId, "contract", [delivery.contractRef]);
      await this.assertEvidenceAssets(c, workspaceId, deliveryId, "payment", delivery.paymentEvidenceRefs);
      for (const checklistKey of ["system_integration", "functional_acceptance"] as const) {
        await this.assertEvidenceAssets(
          c,
          workspaceId,
          deliveryId,
          checklistKey,
          checklistItems
            .filter(item => item.checklistKey === checklistKey && item.completed)
            .flatMap(item => customerDeliveryEvidenceRefs(item.evidence?.asset_refs)),
        );
      }
      await this.assertEvidenceAssets(
        c,
        workspaceId,
        deliveryId,
        "video",
        delivery.videos.map(video => video.assetRef),
      );
    }
    await c.query(
      `UPDATE workspace_customer_deliveries SET effective_at=CASE WHEN $3 THEN COALESCE(effective_at,updated_at) ELSE NULL END WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, deliveryId, ready],
    );
  }
  async list(workspaceId: string) {
    const scope = requireWorkspaceScope(workspaceId);
    const ids = await withWorkspaceTransaction(this.pool, scope, async c =>
      (await c.query<{ id: string }>(
        `SELECT id FROM workspace_customer_deliveries WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC,id DESC /* delivery_evidence_list_ids */`,
        [scope],
      )).rows);
    const result: CustomerDelivery[] = [];
    // Do not keep one delivery's shared parent lock while checking the next
    // delivery's assets: that would reintroduce a cross-delivery lock inversion.
    for (const { id } of ids) {
      const delivery = await this.readWithEvidence(scope, id);
      if (delivery) result.push(delivery);
    }
    return result;
  }
  async get(workspaceId: string, id: string) {
    const scope = requireWorkspaceScope(workspaceId);
    return this.readWithEvidence(scope, id);
  }
  async listChecklistItems(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
  }) {
    const scope = requireWorkspaceScope(input.workspaceId);
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
      const d = await c.query(
        `SELECT id FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId],
      );
      if (!d.rows[0])
        throw new CustomerDeliveryError(
          "NOT_FOUND",
          "customer delivery not found",
        );
      const q = await c.query(
        `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND checklist_key=$3 ORDER BY item_key`,
        [scope, input.deliveryId, input.checklistKey],
      );
      return q.rows.map((r) => this.mapItem(r));
    });
  }
  async updateChecklistItem(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    itemKey: string;
    completed: boolean;
    evidence?: Record<string, unknown>;
    actorId: string;
    expectedRevision: number;
  }) {
    input = { ...input, evidence: normalizeChecklistEvidence(input.evidence) };
    const scope = requireWorkspaceScope(input.workspaceId);
    if (
      !input.itemKey?.trim() ||
      !CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[input.checklistKey].includes(
        input.itemKey.trim() as never,
      )
    )
      throw new CustomerDeliveryError(
        "INVALID_INPUT",
        "unknown checklist item",
      );
    return this.withEvidenceTransaction(scope, input.deliveryId, { ...input, kind: "item" }, async (c) => {
      const cur = await c.query(
        `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [scope, input.deliveryId],
      );
      const d = cur.rows[0];
      if (!d)
        throw new CustomerDeliveryError(
          "NOT_FOUND",
          "customer delivery not found",
        );
      if (Number(d.revision) !== input.expectedRevision)
        throw new CustomerDeliveryError(
          "REVISION_CONFLICT",
          "revision changed",
        );
      await this.assertEvidenceAssets(
        c,
        scope,
        input.deliveryId,
        input.checklistKey,
        customerDeliveryEvidenceRefs(input.evidence?.asset_refs),
      );
      // Capture the persisted item before the upsert so the audit trail
      // contains the actual prior state (or an empty object for first write).
      // The delivery row is locked above, serializing checklist mutations for
      // this customer while we read and update the item.
      const previous = await c.query(
        `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND checklist_key=$3 AND item_key=$4 LIMIT 1`,
        [scope, input.deliveryId, input.checklistKey, input.itemKey.trim()],
      );
      const q = await c.query(
        `INSERT INTO workspace_customer_delivery_checklist_items (workspace_id,delivery_id,checklist_key,item_key,completed,evidence,completed_by_actor_id,completed_at,revision,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,CASE WHEN $5 THEN now() ELSE NULL END,1,now()) ON CONFLICT (workspace_id,delivery_id,checklist_key,item_key) DO UPDATE SET completed=EXCLUDED.completed,evidence=EXCLUDED.evidence,completed_by_actor_id=EXCLUDED.completed_by_actor_id,completed_at=EXCLUDED.completed_at,revision=workspace_customer_delivery_checklist_items.revision+1,updated_at=now() RETURNING *`,
        [
          scope,
          input.deliveryId,
          input.checklistKey,
          input.itemKey.trim(),
          Boolean(input.completed),
          JSON.stringify(input.evidence ?? {}),
          input.completed ? input.actorId : null,
        ],
      );
      const currentItems = await c.query(
        `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND checklist_key=$3`,
        [scope, input.deliveryId, input.checklistKey],
      );
      const status = checklistComplete(input.checklistKey, currentItems.rows.map(row => this.mapItem(row))) ? "complete" : "incomplete";
      const sets =
        input.checklistKey === "system_integration"
          ? `system_integration_status='${status}'`
          : `functional_acceptance_status='${status}'`;
      await c.query(
        `UPDATE workspace_customer_deliveries SET ${sets},revision=revision+1,updated_at=now(),updated_by_actor_id=$3 WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId, input.actorId],
      );
      // SET expressions read the pre-update row in PostgreSQL. Recalculate
      // only after writing the new checklist state, within the same lock/tx.
      await this.refreshEffectiveAt(c, scope, input.deliveryId);
      await this.audit(c, {
        workspaceId: scope,
        actorId: input.actorId,
        action: "customer_delivery.checklist_item.update",
        resourceType: "customer_delivery_checklist_item",
        resourceId: `${input.deliveryId}:${input.checklistKey}:${input.itemKey}`,
        before: previous.rows[0]
          ? (this.mapItem(previous.rows[0]) as any)
          : {},
        after: this.mapItem(q.rows[0]!) as any,
        reason: "更新客户交付清单项",
      });
      return this.mapItem(q.rows[0]!);
    });
  }
  async updateChecklistItems(input: {
    workspaceId: string;
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    items: CustomerDeliveryChecklistBatchItem[];
    actorId: string;
    expectedRevision: number;
  }): Promise<CustomerDeliveryChecklistItem[]> {
    const scope = requireWorkspaceScope(input.workspaceId);
    const expectedKeys = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[
      input.checklistKey
    ] as readonly string[];
    if (
      !Array.isArray(input.items) ||
      input.items.length !== expectedKeys.length
    )
      throw new CustomerDeliveryError(
        "INVALID_INPUT",
        `items_json must contain exactly ${expectedKeys.length} items`,
      );
    const normalized = input.items.map((item) => ({
      ...item,
      itemKey: item.itemKey?.trim(),
      evidence: normalizeChecklistEvidence(item.evidence),
    }));
    const seen = new Set<string>();
    for (const item of normalized) {
      if (
        !item.itemKey ||
        seen.has(item.itemKey) ||
        !expectedKeys.includes(item.itemKey)
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "items_json contains duplicate, empty, or unknown itemKey",
        );
      if (typeof item.completed !== "boolean")
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "completed must be boolean",
        );
      seen.add(item.itemKey);
      if (
        item.evidence !== undefined &&
        (item.evidence === null ||
          typeof item.evidence !== "object" ||
          Array.isArray(item.evidence))
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "evidence must be an object",
        );
    }
    return this.withEvidenceTransaction(scope, input.deliveryId, { ...input, items: normalized, kind: "batch" }, async (c) => {
      const cur = await c.query(
        `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [scope, input.deliveryId],
      );
      const delivery = cur.rows[0];
      if (!delivery)
        throw new CustomerDeliveryError(
          "NOT_FOUND",
          "customer delivery not found",
        );
      if (Number(delivery.revision) !== input.expectedRevision)
        throw new CustomerDeliveryError(
          "REVISION_CONFLICT",
          "revision changed",
        );
      for (const item of normalized) {
        await this.assertEvidenceAssets(
          c,
          scope,
          input.deliveryId,
          input.checklistKey,
          customerDeliveryEvidenceRefs(item.evidence?.asset_refs),
        );
      }
      const keys = [...seen];
      const before = await c.query(
        `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND checklist_key=$3 AND item_key = ANY($4::text[]) ORDER BY item_key`,
        [scope, input.deliveryId, input.checklistKey, keys],
      );
      const saved: any[] = [];
      for (const item of normalized) {
        const q = await c.query(
          `INSERT INTO workspace_customer_delivery_checklist_items (workspace_id,delivery_id,checklist_key,item_key,completed,evidence,completed_by_actor_id,completed_at,revision,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,CASE WHEN $5 THEN now() ELSE NULL END,1,now()) ON CONFLICT (workspace_id,delivery_id,checklist_key,item_key) DO UPDATE SET completed=EXCLUDED.completed,evidence=EXCLUDED.evidence,completed_by_actor_id=EXCLUDED.completed_by_actor_id,completed_at=EXCLUDED.completed_at,revision=workspace_customer_delivery_checklist_items.revision+1,updated_at=now() RETURNING *`,
          [
            scope,
            input.deliveryId,
            input.checklistKey,
            item.itemKey,
            Boolean(item.completed),
            JSON.stringify(item.evidence ?? {}),
            item.completed ? input.actorId : null,
          ],
        );
        saved.push(q.rows[0]);
      }
      const currentItems = await c.query(
        `SELECT * FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND checklist_key=$3`,
        [scope, input.deliveryId, input.checklistKey],
      );
      const status = checklistComplete(input.checklistKey, currentItems.rows.map(row => this.mapItem(row))) ? "complete" : "incomplete";
      if (input.checklistKey === "system_integration")
        await c.query(
          `UPDATE workspace_customer_deliveries SET system_integration_status=$3,revision=revision+1,updated_at=now(),updated_by_actor_id=$4 WHERE workspace_id=$1 AND id=$2`,
          [scope, input.deliveryId, status, input.actorId],
        );
      else
        await c.query(
          `UPDATE workspace_customer_deliveries SET functional_acceptance_status=$3,revision=revision+1,updated_at=now(),updated_by_actor_id=$4 WHERE workspace_id=$1 AND id=$2`,
          [scope, input.deliveryId, status, input.actorId],
        );
      await this.refreshEffectiveAt(c, scope, input.deliveryId);
      const updated = await c.query(
        `SELECT revision FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId],
      );
      const result = saved.map((row) => this.mapItem(row));
      await this.audit(c, {
        workspaceId: scope,
        actorId: input.actorId,
        action: "customer_delivery.checklist_items.update",
        resourceType: "customer_delivery_checklist_items",
        resourceId: `${input.deliveryId}:${input.checklistKey}`,
        before: {
          revision: input.expectedRevision,
          items: before.rows.map((row) => this.mapItem(row)),
        },
        after: { revision: Number(updated.rows[0]?.revision), items: result },
        reason: "批量更新客户交付清单项",
      });
      return result;
    });
  }
  async create(input: {
    workspaceId: string;
    companyName: string;
    actorId: string;
  }): Promise<CustomerDelivery> {
    const scope = requireWorkspaceScope(input.workspaceId);
    const name = input.companyName?.trim();
    if (!name)
      throw new CustomerDeliveryError("INVALID_INPUT", "companyName required");
    const id = `cd_${randomUUID()}`;
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
      try {
        const q = await c.query(
          `INSERT INTO workspace_customer_deliveries (id,workspace_id,company_name,created_by_actor_id,updated_by_actor_id) VALUES ($1,$2,$3,$4,$4) RETURNING *`,
          [id, scope, name, input.actorId],
        );
        const d = this.map(q.rows[0]);
        await this.audit(c, {
          workspaceId: scope,
          actorId: input.actorId,
          action: "customer_delivery.create",
          resourceType: "customer_delivery",
          resourceId: id,
          before: {},
          after: d as unknown as Record<string, unknown>,
          reason: "创建客户交付档案",
        });
        return d;
      } catch (e: any) {
        if (e?.code === "23505")
          throw new CustomerDeliveryError(
            "DUPLICATE_COMPANY",
            "company already exists",
          );
        throw e;
      }
    });
  }
  async update(input: {
    workspaceId: string;
    id: string;
    actorId: string;
    expectedRevision: number;
    patch: CustomerDeliveryPatch;
  }): Promise<CustomerDelivery> {
    const scope = requireWorkspaceScope(input.workspaceId);
    const p = normalizeDeliveryPatch(input.patch);
    if (p.companyName !== undefined && !p.companyName.trim())
      throw new CustomerDeliveryError("INVALID_INPUT", "companyName required");
    const keys = (Object.keys(p) as Array<keyof typeof p>).filter(
      (k) => p[k] !== undefined,
    );
    if (!keys.length) {
      const current = await this.readWithEvidence(scope, input.id);
      if (!current) throw new CustomerDeliveryError("NOT_FOUND", "customer delivery not found");
      if (current.revision !== input.expectedRevision) throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
      return current;
    }
    return this.withEvidenceTransaction(scope, input.id, { kind: "update", expectedRevision: input.expectedRevision, patch: p }, async (c) => {
      const cur = await c.query(
        `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [scope, input.id],
      );
      const row = cur.rows[0];
      if (!row)
        throw new CustomerDeliveryError(
          "NOT_FOUND",
          "customer delivery not found",
        );
      if (Number(row.revision) !== input.expectedRevision)
        throw new CustomerDeliveryError(
          "REVISION_CONFLICT",
          "revision changed",
        );
      if ("contractRef" in p && p.contractRef != null && !isValidCustomerDeliveryContractRef(p.contractRef))
        throw new CustomerDeliveryError("INVALID_INPUT", "合同必须是已上传并扫描通过的 asset_ref");
      const before = this.map(row);
      const candidate = { ...before, ...p };
      if ((Object.hasOwn(p, "contractRef") || p.customerProfileStatus === "complete")
        && candidate.contractRef)
        await this.assertEvidenceAssets(c, scope, input.id, "contract", [candidate.contractRef]);
      if (Object.hasOwn(p, "paymentEvidenceRefs")
        || ((Object.hasOwn(p, "paymentStatus") || Object.hasOwn(p, "paymentDate")) && candidate.paymentStatus === "paid"))
        await this.assertEvidenceAssets(c, scope, input.id, "payment", candidate.paymentEvidenceRefs);
      if (Object.hasOwn(p, "trainingEvidenceRefs")
        || (Object.hasOwn(p, "trainingCompleted") && candidate.trainingCompleted))
        await this.assertEvidenceAssets(c, scope, input.id, "training", candidate.trainingEvidenceRefs);
      if (
        (p.customerProfileStatus === "complete" || (row.customer_profile_status === "complete" && p.customerProfileStatus !== "incomplete")) &&
        (!candidate.contractNumber?.trim() ||
          !isValidCustomerDeliveryContractRef(candidate.contractRef) ||
          !candidate.projectOwner?.trim() ||
          !candidate.supportOwner?.trim() ||
          (candidate.paymentStatus === "paid" && !candidate.paymentDate) ||
          !candidate.plannedGoLiveAt)
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "客户档案字段未填写完整",
        );
      const vals: any[] = [
        scope,
        input.id,
        input.actorId,
        input.expectedRevision,
      ];
      const sets: string[] = [];
      const col: Record<string, string> = {
        companyName: "company_name",
        contractNumber: "contract_number",
        paymentStatus: "payment_status",
        contractRef: "contract_ref",
        projectOwner: "project_owner",
        supportOwner: "support_owner",
        paymentDate: "payment_date",
        paymentEvidenceRefs: "payment_evidence_refs",
        plannedGoLiveAt: "planned_go_live_at",
        customerProfileStatus: "customer_profile_status",
        trainingCompleted: "training_completed",
        trainingEvidenceRefs: "training_evidence_refs",
        archivedAt: "archived_at",
      };
      for (const k of keys) {
        sets.push(`${col[k]}=$${vals.length + 1}`);
        vals.push(p[k]);
      }
      if (!sets.length) return (await this.withVideos(c, [row]))[0]!;
      sets.push(
        `updated_by_actor_id=$3`,
        ...(Object.hasOwn(p, "archivedAt") ? [`archived_by_actor_id=CASE WHEN archived_at IS NULL THEN $3 ELSE NULL END`] : []),
        `updated_at=now()`,
        `revision=revision+1`,
      );
      // Capture actual old videos while holding the same parent lock used by
      // video writers. Audit the historical raw effective_at, not read projection.
      const beforeVideos = await c.query(
        `SELECT * FROM workspace_customer_delivery_videos WHERE workspace_id=$1 AND delivery_id=$2 AND deleted_at IS NULL ORDER BY sort_order,id`,
        [scope, input.id],
      );
      before.videos = beforeVideos.rows.map(video => this.mapVideo(video));
      const q = await c.query(
        `UPDATE workspace_customer_deliveries SET ${sets.join(",")} WHERE workspace_id=$1 AND id=$2 AND revision=$4 RETURNING *`,
        vals,
      );
      if (!q.rows[0])
        throw new CustomerDeliveryError(
          "REVISION_CONFLICT",
          "revision changed",
        );
      await this.refreshEffectiveAt(c, scope, input.id);
      const final = await c.query(
        `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2`,
        [scope, input.id],
      );
      const result = (await this.withVideos(c, final.rows))[0]!;
      await this.audit(c, {
        workspaceId: scope,
        actorId: input.actorId,
        action: "customer_delivery.update",
        resourceType: "customer_delivery",
        resourceId: input.id,
        before: before as unknown as Record<string, unknown>,
        after: result as unknown as Record<string, unknown>,
        reason: "更新客户交付档案",
      });
      return result;
    });
  }
  async addVideo(input: {
    workspaceId: string;
    deliveryId: string;
    actorId: string;
    title: string;
    assetRef: string;
    sortOrder?: number;
  }): Promise<CustomerDeliveryVideo> {
    const scope = requireWorkspaceScope(input.workspaceId);
    const title = input.title?.trim(),
      asset = input.assetRef?.trim();
    if (!title || !asset)
      throw new CustomerDeliveryError(
        "INVALID_INPUT",
        "video title and assetRef required",
      );
    return this.withEvidenceTransaction(scope, input.deliveryId, { kind: "add_video", assetRef: asset }, async (c) => {
      const exists = await c.query(
        `SELECT id FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [scope, input.deliveryId],
      );
      if (!exists.rows[0])
        throw new CustomerDeliveryError(
          "NOT_FOUND",
          "customer delivery not found",
        );
      await this.assertEvidenceAssets(c, scope, input.deliveryId, "video", [asset]);
      const q = await c.query(
        `INSERT INTO workspace_customer_delivery_videos (id,workspace_id,delivery_id,title,asset_ref,sort_order,uploaded_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          `cdv_${randomUUID()}`,
          scope,
          input.deliveryId,
          title,
          asset,
          input.sortOrder ?? 0,
          input.actorId,
        ],
      );
      await c.query(
        `UPDATE workspace_customer_deliveries SET revision=revision+1,updated_at=now(),updated_by_actor_id=$3 WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId, input.actorId],
      );
      await this.refreshEffectiveAt(c, scope, input.deliveryId);
      const video = this.mapVideo(q.rows[0]);
      await this.audit(c, {
        workspaceId: scope,
        actorId: input.actorId,
        action: "customer_delivery.video.add",
        resourceType: "customer_delivery_video",
        resourceId: video.id,
        before: {},
        after: video as unknown as Record<string, unknown>,
        reason: "添加客户交付视频",
      });
      return video;
    });
  }
  async removeVideo(input: {
    workspaceId: string;
    deliveryId: string;
    videoId: string;
    actorId: string;
  }): Promise<void> {
    const scope = requireWorkspaceScope(input.workspaceId);
    return this.withEvidenceTransaction(scope, input.deliveryId, { kind: "remove_video", videoId: input.videoId }, async (c) => {
      const delivery = await c.query(
        `SELECT id FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [scope, input.deliveryId],
      );
      if (!delivery.rows[0]) throw new CustomerDeliveryError("NOT_FOUND", "customer delivery not found");
      const q = await c.query(
        `UPDATE workspace_customer_delivery_videos SET deleted_at=now() WHERE workspace_id=$1 AND delivery_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING id`,
        [scope, input.deliveryId, input.videoId],
      );
      if (!q.rows[0])
        throw new CustomerDeliveryError("NOT_FOUND", "video not found");
      await c.query(
        `UPDATE workspace_customer_deliveries SET revision=revision+1,updated_at=now(),updated_by_actor_id=$3 WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId, input.actorId],
      );
      await this.refreshEffectiveAt(c, scope, input.deliveryId);
      await this.audit(c, {
        workspaceId: scope,
        actorId: input.actorId,
        action: "customer_delivery.video.remove",
        resourceType: "customer_delivery_video",
        resourceId: input.videoId,
        before: { video_id: input.videoId, deleted_at: null },
        after: { video_id: input.videoId, softDelete: true },
        reason: "移除客户交付视频（软删除）",
      });
    });
  }
}
