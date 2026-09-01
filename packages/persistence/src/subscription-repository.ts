import { createHash, randomUUID } from "node:crypto";
import {
  requireWorkspaceScope,
  type OutboxEventInput,
  type SqlClient,
  type SqlPool,
  withWorkspaceTransaction,
} from "./repository.js";

export type SubscriptionStatus =
  "trialing" | "active" | "past_due" | "canceled";
export type BillingCycle = "monthly" | "annual";
export type SubscriptionOrderStatus =
  "pending" | "paid" | "closed" | "refunded";
export interface WorkspaceSubscription {
  workspaceId: string;
  status: SubscriptionStatus;
  planCode: string;
  planName: string;
  billingCycle: BillingCycle;
  priceCny: number;
  includedStores: number;
  includedTasks: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  revision: number;
  updatedAt: string;
}
export interface SubscriptionOrder {
  id: string;
  workspaceId: string;
  orderNo: string;
  planCode: string;
  planName: string;
  billingCycle: BillingCycle;
  priceCny: number;
  paymentAmountCny: number;
  includedStores: number;
  includedTasks: number;
  couponCode?: string;
  addonCodes: string[];
  sourceChannel?: string;
  status: SubscriptionOrderStatus;
  paymentProvider: string;
  paymentUrl?: string;
  providerTradeId?: string;
  createdByActorId?: string;
  idempotencyKey: string;
  createdAt: string;
  paidAt?: string;
}
export interface SubscriptionRepository {
  get(workspaceId: string): Promise<WorkspaceSubscription>;
  createOrder(input: {
    workspaceId: string;
    orderNo?: string;
    planCode: string;
    planName: string;
    billingCycle: BillingCycle;
    priceCny: number;
    paymentAmountCny?: number;
    includedStores: number;
    includedTasks: number;
    couponCode?: string;
    addonCodes?: string[];
    sourceChannel?: string;
    paymentProvider: string;
    paymentUrl?: string;
    createdByActorId?: string;
    idempotencyKey: string;
  }): Promise<SubscriptionOrder>;
  getOrderByOrderNo(
    workspaceId: string,
    orderNo: string,
  ): Promise<SubscriptionOrder | undefined>;
  getOrderByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<SubscriptionOrder | undefined>;
  listOrders(
    workspaceId: string,
    limit?: number,
    actorId?: string,
  ): Promise<SubscriptionOrder[]>;
  markPaid(input: {
    workspaceId: string;
    orderNo: string;
    providerTradeId: string;
    eventSource: string;
  }): Promise<SubscriptionOrder>;
}

export class SubscriptionOrderIdempotencyConflictError extends Error {
  readonly code = "SUBSCRIPTION_ORDER_IDEMPOTENCY_CONFLICT";
  constructor() {
    super(
      "subscription order idempotency key was reused with a different intent",
    );
    this.name = "SubscriptionOrderIdempotencyConflictError";
  }
}

function requireOrderIdempotencyKey(value: string) {
  if (!value.trim())
    throw new Error("SUBSCRIPTION_ORDER_IDEMPOTENCY_KEY_REQUIRED");
}

function orderIntent(input: {
  planCode: string;
  planName: string;
  billingCycle: BillingCycle;
  priceCny: number;
  paymentAmountCny?: number;
  includedStores: number;
  includedTasks: number;
  couponCode?: string;
  addonCodes?: string[];
  sourceChannel?: string;
  paymentProvider: string;
  createdByActorId?: string;
}) {
  return JSON.stringify({
    planCode: input.planCode,
    planName: input.planName,
    billingCycle: input.billingCycle,
    priceCny: input.priceCny,
    paymentAmountCny: input.paymentAmountCny ?? input.priceCny,
    includedStores: input.includedStores,
    includedTasks: input.includedTasks,
    couponCode: input.couponCode ?? null,
    addonCodes: [...(input.addonCodes ?? [])].sort(),
    sourceChannel: input.sourceChannel ?? null,
    paymentProvider: input.paymentProvider,
    createdByActorId: input.createdByActorId ?? null,
  });
}

function commercialSnapshot(input: SubscriptionOrder) {
  return {
    schema_version: 1,
    order_no: input.orderNo,
    plan_code: input.planCode,
    plan_name: input.planName,
    billing_cycle: input.billingCycle,
    price_cny: input.priceCny,
    payment_amount_cny: input.paymentAmountCny,
    included_stores: input.includedStores,
    included_tasks: input.includedTasks,
    coupon_code: input.couponCode ?? null,
    addon_codes: [...input.addonCodes].sort(),
    source_channel: input.sourceChannel ?? null,
    payment_provider: input.paymentProvider,
  };
}

function snapshotChecksum(snapshot: ReturnType<typeof commercialSnapshot>) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function cycleEnd(cycle: BillingCycle) {
  const date = new Date();
  date.setMonth(date.getMonth() + (cycle === "annual" ? 12 : 1));
  return date.toISOString();
}
const defaultSubscription = (workspaceId: string): WorkspaceSubscription => {
  const now = new Date().toISOString();
  return {
    workspaceId,
    status: "trialing",
    planCode: "trial",
    planName: "Trial",
    billingCycle: "monthly",
    priceCny: 0,
    includedStores: 1,
    includedTasks: 5,
    currentPeriodStart: now,
    currentPeriodEnd: cycleEnd("monthly"),
    revision: 1,
    updatedAt: now,
  };
};

export class MemorySubscriptionRepository implements SubscriptionRepository {
  private readonly subscriptions = new Map<string, WorkspaceSubscription>();
  private readonly orders = new Map<string, SubscriptionOrder>();
  async get(workspaceId: string) {
    const value =
      this.subscriptions.get(workspaceId) ?? defaultSubscription(workspaceId);
    this.subscriptions.set(workspaceId, value);
    return value;
  }
  async createOrder(input: {
    workspaceId: string;
    orderNo?: string;
    planCode: string;
    planName: string;
    billingCycle: BillingCycle;
    priceCny: number;
    paymentAmountCny?: number;
    includedStores: number;
    includedTasks: number;
    couponCode?: string;
    addonCodes?: string[];
    sourceChannel?: string;
    paymentProvider: string;
    paymentUrl?: string;
    createdByActorId?: string;
    idempotencyKey: string;
  }) {
    requireOrderIdempotencyKey(input.idempotencyKey);
    const existing = [...this.orders.values()].find(
      (item) =>
        item.workspaceId === input.workspaceId &&
        item.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      if (orderIntent(existing) !== orderIntent(input))
        throw new SubscriptionOrderIdempotencyConflictError();
      return existing;
    }
    const order = {
      id: `sub_${randomUUID()}`,
      orderNo:
        input.orderNo ??
        `SO${Date.now()}${Math.floor(Math.random() * 1000)
          .toString()
          .padStart(3, "0")}`,
      ...input,
      paymentAmountCny: input.paymentAmountCny ?? input.priceCny,
      addonCodes: input.addonCodes ?? [],
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    };
    this.orders.set(order.id, order);
    return order;
  }
  async getOrderByOrderNo(workspaceId: string, orderNo: string) {
    return [...this.orders.values()].find(
      (item) => item.workspaceId === workspaceId && item.orderNo === orderNo,
    );
  }
  async getOrderByIdempotencyKey(workspaceId: string, idempotencyKey: string) {
    return [...this.orders.values()].find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.idempotencyKey === idempotencyKey,
    );
  }
  async listOrders(workspaceId: string, limit = 50, actorId?: string) {
    return [...this.orders.values()]
      .filter(
        (item) =>
          item.workspaceId === workspaceId &&
          (!actorId || item.createdByActorId === actorId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(100, Math.max(1, limit)));
  }
  async markPaid(input: {
    workspaceId: string;
    orderNo: string;
    providerTradeId: string;
    eventSource: string;
  }) {
    const order = [...this.orders.values()].find(
      (item) =>
        item.workspaceId === input.workspaceId &&
        item.orderNo === input.orderNo,
    );
    if (!order) throw new Error("SUBSCRIPTION_ORDER_NOT_FOUND");
    if (order.status === "paid") {
      if (order.providerTradeId !== input.providerTradeId)
        throw new Error("SUBSCRIPTION_CALLBACK_REPLAY_CONFLICT");
      return order;
    }
    order.status = "paid";
    order.providerTradeId = input.providerTradeId;
    order.paidAt = new Date().toISOString();
    this.subscriptions.set(input.workspaceId, {
      ...(await this.get(input.workspaceId)),
      status: "active",
      planCode: order.planCode,
      planName: order.planName,
      billingCycle: order.billingCycle,
      priceCny: order.priceCny,
      includedStores: order.includedStores,
      includedTasks: order.includedTasks,
      currentPeriodStart: order.paidAt,
      currentPeriodEnd: cycleEnd(order.billingCycle),
      revision: (await this.get(input.workspaceId)).revision + 1,
      updatedAt: order.paidAt,
    });
    return order;
  }
}

export class PostgresSubscriptionRepository implements SubscriptionRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly appendEvent?: (
      client: SqlClient,
      event: OutboxEventInput,
    ) => Promise<unknown>,
  ) {}
  async get(workspaceId: string) {
    requireWorkspaceScope(workspaceId);
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      await client.query(
        `INSERT INTO workspace_subscriptions (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [workspaceId],
      );
      const result = await client.query<WorkspaceSubscription>(
        `SELECT workspace_id AS "workspaceId", status, plan_code AS "planCode", plan_name AS "planName", billing_cycle AS "billingCycle", price_cny::float8 AS "priceCny", included_stores AS "includedStores", included_tasks AS "includedTasks", current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd", revision, updated_at AS "updatedAt" FROM workspace_subscriptions WHERE workspace_id=$1`,
        [workspaceId],
      );
      return result.rows[0]!;
    });
  }
  async createOrder(input: {
    workspaceId: string;
    orderNo?: string;
    planCode: string;
    planName: string;
    billingCycle: BillingCycle;
    priceCny: number;
    paymentAmountCny?: number;
    includedStores: number;
    includedTasks: number;
    couponCode?: string;
    addonCodes?: string[];
    sourceChannel?: string;
    paymentProvider: string;
    paymentUrl?: string;
    createdByActorId?: string;
    idempotencyKey: string;
  }) {
    requireOrderIdempotencyKey(input.idempotencyKey);
    requireWorkspaceScope(input.workspaceId);
    return withWorkspaceTransaction(
      this.pool,
      input.workspaceId,
      async (client) => {
        const projection = `id, workspace_id AS "workspaceId", order_no AS "orderNo", plan_code AS "planCode", plan_name AS "planName", billing_cycle AS "billingCycle", price_cny::float8 AS "priceCny", payment_amount_cny::float8 AS "paymentAmountCny", included_stores AS "includedStores", included_tasks AS "includedTasks", coupon_code AS "couponCode", addon_codes AS "addonCodes", source_channel AS "sourceChannel", status, payment_provider AS "paymentProvider", payment_url AS "paymentUrl", provider_trade_id AS "providerTradeId", created_by_actor_id AS "createdByActorId", idempotency_key AS "idempotencyKey", created_at AS "createdAt", paid_at AS "paidAt"`;
        const inserted = await client.query<SubscriptionOrder>(
          `INSERT INTO workspace_subscription_orders (id, workspace_id, order_no, plan_code, plan_name, billing_cycle, price_cny, payment_amount_cny, included_stores, included_tasks, coupon_code, addon_codes, source_channel, status, payment_provider, payment_url, created_by_actor_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16,$17) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING ${projection}`,
          [
            randomUUID(),
            input.workspaceId,
            input.orderNo ??
              `SO${Date.now()}${Math.floor(Math.random() * 1000)
                .toString()
                .padStart(3, "0")}`,
            input.planCode,
            input.planName,
            input.billingCycle,
            input.priceCny,
            input.paymentAmountCny ?? input.priceCny,
            input.includedStores,
            input.includedTasks,
            input.couponCode ?? null,
            JSON.stringify(input.addonCodes ?? []),
            input.sourceChannel ?? null,
            input.paymentProvider,
            input.paymentUrl ?? null,
            input.createdByActorId ?? null,
            input.idempotencyKey,
          ],
        );
        const order =
          inserted.rows[0] ??
          (
            await client.query<SubscriptionOrder>(
              `SELECT ${projection} FROM workspace_subscription_orders WHERE workspace_id=$1 AND idempotency_key=$2`,
              [input.workspaceId, input.idempotencyKey],
            )
          ).rows[0];
        if (!order)
          throw new Error("subscription order disappeared before lookup");
        if (orderIntent(order) !== orderIntent(input))
          throw new SubscriptionOrderIdempotencyConflictError();
        const snapshot = commercialSnapshot(order);
        await client.query(
          `INSERT INTO commercial_order_snapshots (id, workspace_id, order_id, snapshot, checksum) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_id) DO NOTHING`,
          [
            randomUUID(),
            order.workspaceId,
            order.id,
            JSON.stringify(snapshot),
            snapshotChecksum(snapshot),
          ],
        );
        return order;
      },
    );
  }
  async getOrderByOrderNo(workspaceId: string, orderNo: string) {
    requireWorkspaceScope(workspaceId);
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      const result = await client.query<SubscriptionOrder>(
        `SELECT id, workspace_id AS "workspaceId", order_no AS "orderNo", plan_code AS "planCode", plan_name AS "planName", billing_cycle AS "billingCycle", price_cny::float8 AS "priceCny", payment_amount_cny::float8 AS "paymentAmountCny", included_stores AS "includedStores", included_tasks AS "includedTasks", coupon_code AS "couponCode", addon_codes AS "addonCodes", source_channel AS "sourceChannel", status, payment_provider AS "paymentProvider", payment_url AS "paymentUrl", provider_trade_id AS "providerTradeId", created_by_actor_id AS "createdByActorId", idempotency_key AS "idempotencyKey", created_at AS "createdAt", paid_at AS "paidAt" FROM workspace_subscription_orders WHERE workspace_id=$1 AND order_no=$2`,
        [workspaceId, orderNo],
      );
      return result.rows[0];
    });
  }
  async getOrderByIdempotencyKey(workspaceId: string, idempotencyKey: string) {
    requireWorkspaceScope(workspaceId);
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      const result = await client.query<SubscriptionOrder>(
        `SELECT id, workspace_id AS "workspaceId", order_no AS "orderNo", plan_code AS "planCode", plan_name AS "planName", billing_cycle AS "billingCycle", price_cny::float8 AS "priceCny", payment_amount_cny::float8 AS "paymentAmountCny", included_stores AS "includedStores", included_tasks AS "includedTasks", coupon_code AS "couponCode", addon_codes AS "addonCodes", source_channel AS "sourceChannel", status, payment_provider AS "paymentProvider", payment_url AS "paymentUrl", provider_trade_id AS "providerTradeId", created_by_actor_id AS "createdByActorId", idempotency_key AS "idempotencyKey", created_at AS "createdAt", paid_at AS "paidAt" FROM workspace_subscription_orders WHERE workspace_id=$1 AND idempotency_key=$2`,
        [workspaceId, idempotencyKey],
      );
      return result.rows[0];
    });
  }
  async listOrders(workspaceId: string, limit = 50, actorId?: string) {
    requireWorkspaceScope(workspaceId);
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      const result = await client.query<SubscriptionOrder>(
        `SELECT id, workspace_id AS "workspaceId", order_no AS "orderNo", plan_code AS "planCode", plan_name AS "planName", billing_cycle AS "billingCycle", price_cny::float8 AS "priceCny", payment_amount_cny::float8 AS "paymentAmountCny", included_stores AS "includedStores", included_tasks AS "includedTasks", coupon_code AS "couponCode", addon_codes AS "addonCodes", source_channel AS "sourceChannel", status, payment_provider AS "paymentProvider", payment_url AS "paymentUrl", provider_trade_id AS "providerTradeId", created_by_actor_id AS "createdByActorId", idempotency_key AS "idempotencyKey", created_at AS "createdAt", paid_at AS "paidAt" FROM workspace_subscription_orders WHERE workspace_id=$1 AND ($3::text IS NULL OR created_by_actor_id=$3) ORDER BY created_at DESC LIMIT $2`,
        [workspaceId, Math.min(100, Math.max(1, limit)), actorId ?? null],
      );
      return result.rows;
    });
  }
  async markPaid(input: {
    workspaceId: string;
    orderNo: string;
    providerTradeId: string;
    eventSource: string;
  }) {
    requireWorkspaceScope(input.workspaceId);
    return withWorkspaceTransaction(
      this.pool,
      input.workspaceId,
      async (client) => {
        const result = await client.query<SubscriptionOrder>(
          `UPDATE workspace_subscription_orders SET status='paid', provider_trade_id=$3, paid_at=now() WHERE workspace_id=$1 AND order_no=$2 AND status='pending' RETURNING id, workspace_id AS "workspaceId", order_no AS "orderNo", plan_code AS "planCode", plan_name AS "planName", billing_cycle AS "billingCycle", price_cny::float8 AS "priceCny", payment_amount_cny::float8 AS "paymentAmountCny", included_stores AS "includedStores", included_tasks AS "includedTasks", coupon_code AS "couponCode", addon_codes AS "addonCodes", source_channel AS "sourceChannel", status, payment_provider AS "paymentProvider", provider_trade_id AS "providerTradeId", idempotency_key AS "idempotencyKey", created_at AS "createdAt", paid_at AS "paidAt"`,
          [input.workspaceId, input.orderNo, input.providerTradeId],
        );
        if (!result.rows[0]) {
          const alreadyPaid = await client.query<SubscriptionOrder>(
            `SELECT id, workspace_id AS "workspaceId", order_no AS "orderNo", plan_code AS "planCode", plan_name AS "planName", billing_cycle AS "billingCycle", price_cny::float8 AS "priceCny", payment_amount_cny::float8 AS "paymentAmountCny", included_stores AS "includedStores", included_tasks AS "includedTasks", coupon_code AS "couponCode", addon_codes AS "addonCodes", source_channel AS "sourceChannel", status, payment_provider AS "paymentProvider", provider_trade_id AS "providerTradeId", idempotency_key AS "idempotencyKey", created_at AS "createdAt", paid_at AS "paidAt" FROM workspace_subscription_orders WHERE workspace_id=$1 AND order_no=$2 AND status='paid' AND provider_trade_id=$3`,
            [input.workspaceId, input.orderNo, input.providerTradeId],
          );
          if (alreadyPaid.rows[0]) return alreadyPaid.rows[0];
          throw new Error("SUBSCRIPTION_ORDER_NOT_FOUND_OR_NOT_PENDING");
        }
        const order = result.rows[0];
        const snapshot = await client.query<{ snapshot: unknown; checksum: string }>(
          `SELECT snapshot, checksum FROM commercial_order_snapshots WHERE workspace_id=$1 AND order_id=$2`,
          [input.workspaceId, order.id],
        );
        if (!snapshot.rows[0]) {
          throw new Error("SUBSCRIPTION_ORDER_SNAPSHOT_NOT_FOUND");
        }
        await client.query(
          `UPDATE workspace_subscriptions SET status='active', plan_code=$2, plan_name=$3, billing_cycle=$4, price_cny=$5, included_stores=$6, included_tasks=$7, current_period_start=now(), current_period_end=now() + CASE WHEN $4='annual' THEN interval '1 year' ELSE interval '1 month' END, revision=revision+1, updated_at=now() WHERE workspace_id=$1`,
          [
            input.workspaceId,
            order.planCode,
            order.planName,
            order.billingCycle,
            order.priceCny,
            order.includedStores,
            order.includedTasks,
          ],
        );
        await this.appendEvent?.(client, {
          workspaceId: input.workspaceId,
          aggregateId: order.orderNo,
          eventType: "subscription.order.paid",
          sequence: 1,
          payload: {
            order_no: order.orderNo,
            provider_trade_id: input.providerTradeId,
            plan_code: order.planCode,
            addon_codes: order.addonCodes,
            included_stores: order.includedStores,
            included_tasks: order.includedTasks,
            source: input.eventSource,
          },
        });
        return order;
      },
    );
  }
}
