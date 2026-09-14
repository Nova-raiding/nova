import { randomUUID } from "node:crypto";
import {
  requireWorkspaceScope,
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
  plannedGoLiveAt: string | null;
  customerProfileStatus: "incomplete" | "complete";
  systemIntegrationStatus: "incomplete" | "complete";
  functionalAcceptanceStatus: "incomplete" | "complete";
  trainingCompleted: boolean;
  effectiveAt: string | null;
  revision: number;
  createdByActorId: string;
  updatedByActorId: string;
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
    patch: Partial<
      Pick<
        CustomerDelivery,
        | "companyName"
        | "contractNumber"
        | "paymentStatus"
        | "contractRef"
        | "projectOwner"
        | "supportOwner"
        | "paymentDate"
        | "plannedGoLiveAt"
        | "customerProfileStatus"
        | "systemIntegrationStatus"
        | "functionalAcceptanceStatus"
        | "trainingCompleted"
      >
    >;
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
const complete = (d: CustomerDelivery) =>
  d.customerProfileStatus === "complete" &&
  d.systemIntegrationStatus === "complete" &&
  d.functionalAcceptanceStatus === "complete" &&
  d.trainingCompleted &&
  d.videos.some((video) => !video.deletedAt);
export class MemoryCustomerDeliveryRepository implements CustomerDeliveryRepository {
  private rows = new Map<string, CustomerDelivery>();
  private items = new Map<string, CustomerDeliveryChecklistItem>();
  constructor(
    private readonly auditWriter: (
      event: CustomerDeliveryAuditEvent,
    ) => Promise<void> | void = () => {},
  ) {}
  async list(workspaceId: string) {
    const s = requireWorkspaceScope(workspaceId);
    return [...this.rows.values()]
      .filter((x) => x.workspaceId === s)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }
  async get(workspaceId: string, id: string) {
    const r = this.rows.get(`${requireWorkspaceScope(workspaceId)}:${id}`);
    return r ? clone(r) : null;
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
      plannedGoLiveAt: null,
      customerProfileStatus: "incomplete",
      systemIntegrationStatus: "incomplete",
      functionalAcceptanceStatus: "incomplete",
      trainingCompleted: false,
      effectiveAt: null,
      revision: 1,
      createdByActorId: input.actorId,
      updatedByActorId: input.actorId,
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
    patch: Partial<
      Pick<
        CustomerDelivery,
        | "companyName"
        | "contractNumber"
        | "paymentStatus"
        | "contractRef"
        | "projectOwner"
        | "supportOwner"
        | "paymentDate"
        | "plannedGoLiveAt"
        | "customerProfileStatus"
        | "systemIntegrationStatus"
        | "functionalAcceptanceStatus"
        | "trainingCompleted"
      >
    >;
  }) {
    const ws = requireWorkspaceScope(input.workspaceId),
      d = this.rows.get(`${ws}:${input.id}`);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    if (d.revision !== input.expectedRevision)
      throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
    if (
      d.paymentStatus === "unpaid" &&
      (
        [
          "systemIntegrationStatus",
          "functionalAcceptanceStatus",
          "trainingCompleted",
        ] as const
      ).some(
        (k) => k in input.patch && input.patch[k] && input.patch[k] !== d[k],
      )
    )
      throw new CustomerDeliveryError(
        "PAYMENT_REQUIRED",
        "customer has not paid",
      );
    if (
      input.patch.companyName !== undefined &&
      !input.patch.companyName.trim()
    )
      throw new CustomerDeliveryError("INVALID_INPUT", "companyName required");
    const before = clone(d);
    const patch = { ...input.patch };
    if (patch.functionalAcceptanceStatus === "complete")
      patch.trainingCompleted = true;
    if (patch.functionalAcceptanceStatus === "incomplete")
      patch.trainingCompleted = false;
    if (patch.customerProfileStatus === "complete") {
      const candidate = { ...d, ...patch };
      if (
        !candidate.contractNumber?.trim() ||
        !candidate.contractRef?.trim() ||
        !candidate.projectOwner?.trim() ||
        !candidate.supportOwner?.trim() ||
        !candidate.paymentDate ||
        !candidate.plannedGoLiveAt
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "客户档案字段未填写完整",
        );
    }
    Object.assign(d, patch);
    d.updatedByActorId = input.actorId;
    d.updatedAt = new Date().toISOString();
    d.revision++;
    d.effectiveAt = complete(d) ? (d.effectiveAt ?? d.updatedAt) : null;
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
    const ws = requireWorkspaceScope(input.workspaceId),
      d = this.rows.get(`${ws}:${input.deliveryId}`);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    if (d.revision !== input.expectedRevision)
      throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
    if (d.paymentStatus === "unpaid")
      throw new CustomerDeliveryError(
        "PAYMENT_REQUIRED",
        "customer has not paid",
      );
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
    const key = `${ws}:${d.id}:${input.checklistKey}:${input.itemKey}`;
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
    const expected = input.checklistKey === "system_integration" ? 10 : 8;
    const status =
      all.length >= expected &&
      all.filter((x) => x.completed).length >= expected
        ? "complete"
        : "incomplete";
    if (input.checklistKey === "system_integration")
      d.systemIntegrationStatus = status;
    else {
      d.functionalAcceptanceStatus = status;
      d.trainingCompleted = status === "complete";
    }
    if (complete(d)) d.effectiveAt = d.effectiveAt ?? now;
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
    const ws = requireWorkspaceScope(input.workspaceId),
      d = this.rows.get(`${ws}:${input.deliveryId}`);
    if (!d)
      throw new CustomerDeliveryError(
        "NOT_FOUND",
        "customer delivery not found",
      );
    if (d.revision !== input.expectedRevision)
      throw new CustomerDeliveryError("REVISION_CONFLICT", "revision changed");
    if (d.paymentStatus === "unpaid")
      throw new CustomerDeliveryError(
        "PAYMENT_REQUIRED",
        "customer has not paid",
      );
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
    const status =
      all.length === expectedKeys.length && all.every((x) => x.completed)
        ? "complete"
        : "incomplete";
    if (input.checklistKey === "system_integration")
      d.systemIntegrationStatus = status;
    else {
      d.functionalAcceptanceStatus = status;
      d.trainingCompleted = status === "complete";
    }
    d.effectiveAt = complete(d) ? (d.effectiveAt ?? now) : null;
    await this.auditWriter({
      workspaceId: ws,
      actorId: input.actorId,
      action: "customer_delivery.checklist_items.update",
      resourceId: d.id,
      before: { revision: input.expectedRevision },
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
    row.revision++;
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
    row.revision++;
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
export class PostgresCustomerDeliveryRepository implements CustomerDeliveryRepository {
  constructor(private readonly pool: SqlPool) {}
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
        `audit_${randomUUID()}`,
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
      paymentDate: r.payment_date
        ? new Date(r.payment_date).toISOString().slice(0, 10)
        : null,
      plannedGoLiveAt: r.planned_go_live_at
        ? new Date(r.planned_go_live_at).toISOString()
        : null,
      customerProfileStatus: r.customer_profile_status,
      systemIntegrationStatus: r.system_integration_status,
      functionalAcceptanceStatus: r.functional_acceptance_status,
      trainingCompleted: Boolean(r.training_completed),
      effectiveAt: r.effective_at
        ? new Date(r.effective_at).toISOString()
        : null,
      revision: Number(r.revision),
      createdByActorId: r.created_by_actor_id,
      updatedByActorId: r.updated_by_actor_id,
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
    return rows.map((r) => this.map(r, by.get(r.id) || []));
  }
  async list(workspaceId: string) {
    const scope = requireWorkspaceScope(workspaceId);
    return withWorkspaceTransaction(this.pool, scope, async (c) =>
      this.withVideos(
        c,
        (
          await c.query(
            `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 ORDER BY updated_at DESC,id DESC`,
            [scope],
          )
        ).rows,
      ),
    );
  }
  async get(workspaceId: string, id: string) {
    const scope = requireWorkspaceScope(workspaceId);
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
      const q = await c.query(
        `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
        [scope, id],
      );
      if (!q.rows[0]) return null;
      return (await this.withVideos(c, q.rows))[0] || null;
    });
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
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
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
      if (d.payment_status === "unpaid")
        throw new CustomerDeliveryError(
          "PAYMENT_REQUIRED",
          "customer has not paid",
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
      const expected = input.checklistKey === "system_integration" ? 10 : 8;
      const count = await c.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE completed)::int AS done FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND checklist_key=$3`,
        [scope, input.deliveryId, input.checklistKey],
      );
      const status =
        Number(count.rows[0]!.total) >= expected &&
        Number(count.rows[0]!.done) >= expected
          ? "complete"
          : "incomplete";
      const sets =
        input.checklistKey === "system_integration"
          ? `system_integration_status='${status}'`
          : `functional_acceptance_status='${status}', training_completed=${status === "complete"}`;
      await c.query(
        `UPDATE workspace_customer_deliveries SET ${sets},revision=revision+1,updated_at=now(),updated_by_actor_id=$3,effective_at=CASE WHEN payment_status='paid' AND customer_profile_status='complete' AND system_integration_status='complete' AND functional_acceptance_status='complete' AND training_completed AND EXISTS (SELECT 1 FROM workspace_customer_delivery_videos v WHERE v.workspace_id=workspace_customer_deliveries.workspace_id AND v.delivery_id=workspace_customer_deliveries.id AND v.deleted_at IS NULL) THEN COALESCE(effective_at,now()) ELSE NULL END WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId, input.actorId],
      );
      await this.audit(c, {
        workspaceId: scope,
        actorId: input.actorId,
        action: "customer_delivery.checklist_item.update",
        resourceType: "customer_delivery_checklist_item",
        resourceId: `${input.deliveryId}:${input.checklistKey}:${input.itemKey}`,
        before: {},
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
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
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
      if (delivery.payment_status === "unpaid")
        throw new CustomerDeliveryError(
          "PAYMENT_REQUIRED",
          "customer has not paid",
        );
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
      const expected = input.checklistKey === "system_integration" ? 10 : 8;
      const count = await c.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE completed)::int AS done FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND checklist_key=$3`,
        [scope, input.deliveryId, input.checklistKey],
      );
      const status =
        Number(count.rows[0]?.total) >= expected &&
        Number(count.rows[0]?.done) >= expected
          ? "complete"
          : "incomplete";
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
      await c.query(
        `UPDATE workspace_customer_deliveries SET effective_at=CASE WHEN payment_status='paid' AND customer_profile_status='complete' AND system_integration_status='complete' AND functional_acceptance_status='complete' AND training_completed AND EXISTS (SELECT 1 FROM workspace_customer_delivery_videos v WHERE v.workspace_id=workspace_customer_deliveries.workspace_id AND v.delivery_id=workspace_customer_deliveries.id AND v.deleted_at IS NULL) THEN COALESCE(effective_at,updated_at) ELSE NULL END WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId],
      );
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
    patch: Partial<
      Pick<
        CustomerDelivery,
        | "companyName"
        | "contractNumber"
        | "paymentStatus"
        | "contractRef"
        | "projectOwner"
        | "supportOwner"
        | "paymentDate"
        | "plannedGoLiveAt"
        | "customerProfileStatus"
        | "systemIntegrationStatus"
        | "functionalAcceptanceStatus"
        | "trainingCompleted"
      >
    >;
  }): Promise<CustomerDelivery> {
    const scope = requireWorkspaceScope(input.workspaceId);
    const p = input.patch;
    if (p.companyName !== undefined && !p.companyName.trim())
      throw new CustomerDeliveryError("INVALID_INPUT", "companyName required");
    const keys = (Object.keys(p) as Array<keyof typeof p>).filter(
      (k) => p[k] !== undefined,
    );
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
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
      if (
        p.customerProfileStatus === "complete" &&
        (!String(p.contractNumber ?? row.contract_number ?? "").trim() ||
          !String(p.contractRef ?? row.contract_ref ?? "").trim() ||
          !String(p.projectOwner ?? row.project_owner ?? "").trim() ||
          !String(p.supportOwner ?? row.support_owner ?? "").trim() ||
          !(p.paymentDate ?? row.payment_date) ||
          !(p.plannedGoLiveAt ?? row.planned_go_live_at))
      )
        throw new CustomerDeliveryError(
          "INVALID_INPUT",
          "客户档案字段未填写完整",
        );
      if (
        row.payment_status === "unpaid" &&
        (("systemIntegrationStatus" in p &&
          p.systemIntegrationStatus === "complete") ||
          ("functionalAcceptanceStatus" in p &&
            p.functionalAcceptanceStatus === "complete") ||
          ("trainingCompleted" in p && p.trainingCompleted === true))
      )
        throw new CustomerDeliveryError(
          "PAYMENT_REQUIRED",
          "customer has not paid",
        );
      const before = this.map(row);
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
        plannedGoLiveAt: "planned_go_live_at",
        customerProfileStatus: "customer_profile_status",
        systemIntegrationStatus: "system_integration_status",
        functionalAcceptanceStatus: "functional_acceptance_status",
        trainingCompleted: "training_completed",
      };
      for (const k of keys) {
        sets.push(`${col[k]}=$${vals.length + 1}`);
        vals.push(p[k]);
      }
      if (!sets.length) return this.map(row);
      sets.push(
        `updated_by_actor_id=$3`,
        `updated_at=now()`,
        `revision=revision+1`,
      );
      const q = await c.query(
        `UPDATE workspace_customer_deliveries SET ${sets.join(",")} WHERE workspace_id=$1 AND id=$2 AND revision=$4 RETURNING *`,
        vals,
      );
      if (!q.rows[0])
        throw new CustomerDeliveryError(
          "REVISION_CONFLICT",
          "revision changed",
        );
      const updated = q.rows[0];
      await c.query(
        `UPDATE workspace_customer_deliveries SET effective_at=CASE WHEN payment_status='paid' AND customer_profile_status='complete' AND system_integration_status='complete' AND functional_acceptance_status='complete' AND training_completed AND EXISTS (SELECT 1 FROM workspace_customer_delivery_videos v WHERE v.workspace_id=workspace_customer_deliveries.workspace_id AND v.delivery_id=workspace_customer_deliveries.id AND v.deleted_at IS NULL) THEN COALESCE(effective_at,updated_at) ELSE NULL END WHERE workspace_id=$1 AND id=$2`,
        [scope, input.id],
      );
      const final = await c.query(
        `SELECT * FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2`,
        [scope, input.id],
      );
      const result = this.map(final.rows[0]);
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
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
      const exists = await c.query(
        `SELECT id FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2`,
        [scope, input.deliveryId],
      );
      if (!exists.rows[0])
        throw new CustomerDeliveryError(
          "NOT_FOUND",
          "customer delivery not found",
        );
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
    return withWorkspaceTransaction(this.pool, scope, async (c) => {
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
