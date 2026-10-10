import { describe, expect, it, vi } from "vitest";
import {
  MemorySubscriptionRepository,
  PostgresSubscriptionRepository,
  SubscriptionOrderIdempotencyConflictError,
} from "./subscription-repository.js";
import type { SqlClient, SqlPool } from "./repository.js";

type Row = Record<string, unknown>;

class RecordingClient implements SqlClient {
  readonly calls: string[] = [];
  private readonly responses: Array<{ rows: Row[] }> = [];
  enqueue(rows: Row[] = []) {
    this.responses.push({ rows });
  }
  async query<T = Row>(text: string) {
    this.calls.push(text);
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] };
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() {
    return this.client;
  }
}

describe("PostgresSubscriptionRepository", () => {
  it("orders tied subscription timestamps by id for a stable bounded result", async () => {
    const client = new RecordingClient();
    client.enqueue();
    client.enqueue();
    client.enqueue([]);

    await new PostgresSubscriptionRepository(new RecordingPool(client)).listOrders(
      "ws_subscription",
      25,
    );

    expect(client.calls.find((call) => call.includes("FROM workspace_subscription_orders")))
      .toMatch(/ORDER BY created_at DESC,id DESC LIMIT \$2/u);
  });

  it("rejects unsafe or channel-mismatched checkout URLs before SQL and gates fixture URLs", async () => {
    const client = new RecordingClient();
    const base = { workspaceId: "ws_subscription", planCode: "starter", planName: "Starter", billingCycle: "monthly" as const, priceCny: 99, includedStores: 2, includedTasks: 100, idempotencyKey: "checkout-url", paymentUrl: "alipays://platformapi/startapp?appId=123" };
    const productionRepository = new PostgresSubscriptionRepository(new RecordingPool(client));

    await expect(productionRepository.createOrder({ ...base, paymentProvider: "wechat" })).rejects.toThrow("safe supported provider checkout URI");
    await expect(productionRepository.createOrder({ ...base, paymentProvider: "alipay", paymentUrl: "fixture://alipay/order" })).rejects.toThrow("safe supported provider checkout URI");
    await expect(productionRepository.createOrder({ ...base, paymentProvider: "alipay", paymentUrl: "https://user:secret@pay.example/order" })).rejects.toThrow("safe supported provider checkout URI");
    await expect(productionRepository.createOrder({ ...base, paymentProvider: "manual_transfer", paymentUrl: "https://pay.example/order" })).rejects.toThrow("supported payment channel");
    expect(client.calls).toHaveLength(0);

    const fixtureClient = new RecordingClient();
    fixtureClient.enqueue();
    fixtureClient.enqueue();
    fixtureClient.enqueue([{ id: "sub-fixture", workspaceId: base.workspaceId, orderNo: "SO-fixture", planCode: base.planCode, planName: base.planName, billingCycle: base.billingCycle, priceCny: base.priceCny, paymentAmountCny: base.priceCny, includedStores: base.includedStores, includedTasks: base.includedTasks, addonCodes: [], status: "pending", paymentProvider: "alipay", paymentUrl: "fixture://alipay/order", idempotencyKey: base.idempotencyKey }]);
    fixtureClient.enqueue();
    fixtureClient.enqueue();
    const localFixtureRepository = new PostgresSubscriptionRepository(new RecordingPool(fixtureClient), undefined, true);
    await expect(localFixtureRepository.createOrder({ ...base, paymentProvider: "alipay", paymentUrl: "fixture://alipay/order" })).resolves.toMatchObject({ paymentUrl: "fixture://alipay/order" });
  });

  const paidOrder = {
    id: "sub_1",
    workspaceId: "ws_subscription",
    orderNo: "SO1",
    planCode: "pro",
    planName: "Pro",
    billingCycle: "monthly",
    priceCny: 299,
    paymentAmountCny: 299,
    includedStores: 5,
    includedTasks: 500,
    addonCodes: ["video"],
    status: "paid",
    paymentProvider: "alipay",
    providerTradeId: "trade_1",
    idempotencyKey: "sub-key",
    createdAt: "2026-08-01T00:00:00.000Z",
    paidAt: "2026-08-28T00:00:00.000Z",
  };

  it("projects only columns that exist on workspace_subscriptions", async () => {
    const client = new RecordingClient();
    client.enqueue();
    client.enqueue();
    client.enqueue();
    client.enqueue([
      {
        workspaceId: "ws_subscription",
        status: "trialing",
        planCode: "trial",
        planName: "Trial",
        billingCycle: "monthly",
        priceCny: 0,
        includedStores: 1,
        includedTasks: 5,
        currentPeriodStart: "2026-08-01T00:00:00.000Z",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        revision: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    client.enqueue();

    const result = await new PostgresSubscriptionRepository(
      new RecordingPool(client),
    ).get("ws_subscription");

    expect(result.planCode).toBe("trial");
    expect(client.calls[3]).not.toContain("payment_amount_cny");
  });

  it("commits the paid order, active subscription and source event in one transaction", async () => {
    const client = new RecordingClient();
    client.enqueue();
    client.enqueue();
    client.enqueue([paidOrder]);
    client.enqueue([{ snapshot: { schema_version: 1, order_no: "SO1" }, checksum: "a".repeat(64) }]);
    client.enqueue();
    client.enqueue();
    const appendEvent = vi.fn(async () => undefined);

    await new PostgresSubscriptionRepository(
      new RecordingPool(client),
      appendEvent,
    ).markPaid({
      workspaceId: "ws_subscription",
      orderNo: "SO1",
      providerTradeId: "trade_1",
      eventSource: "provider_callback",
    });

    expect(appendEvent).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        eventType: "subscription.order.paid",
        aggregateId: "SO1",
        payload: expect.objectContaining({
          plan_code: "pro",
          source: "provider_callback",
        }),
      }),
    );
    expect(client.calls.at(-1)).toBe("COMMIT");
  });

  it("rolls back subscription activation when the source event cannot be persisted", async () => {
    const client = new RecordingClient();
    client.enqueue();
    client.enqueue();
    client.enqueue([paidOrder]);
    client.enqueue([{ snapshot: { schema_version: 1, order_no: "SO1" }, checksum: "a".repeat(64) }]);
    client.enqueue();
    client.enqueue();
    const repository = new PostgresSubscriptionRepository(
      new RecordingPool(client),
      async () => {
        throw new Error("outbox unavailable");
      },
    );

    await expect(
      repository.markPaid({
        workspaceId: "ws_subscription",
        orderNo: "SO1",
        providerTradeId: "trade_1",
        eventSource: "provider_callback",
      }),
    ).rejects.toThrow("outbox unavailable");
    expect(client.calls.at(-1)).toBe("ROLLBACK");
    expect(client.calls).not.toContain("COMMIT");
  });

  it("fails closed before activation when the immutable order snapshot is missing", async () => {
    const client = new RecordingClient();
    client.enqueue();
    client.enqueue();
    client.enqueue([paidOrder]);

    await expect(
      new PostgresSubscriptionRepository(new RecordingPool(client)).markPaid({
        workspaceId: "ws_subscription",
        orderNo: "SO1",
        providerTradeId: "trade_1",
        eventSource: "provider_callback",
      }),
    ).rejects.toThrow("SUBSCRIPTION_ORDER_SNAPSHOT_NOT_FOUND");
    expect(client.calls.some((call) => call.includes("UPDATE workspace_subscriptions"))).toBe(false);
    expect(client.calls.at(-1)).toBe("ROLLBACK");
  });
});

describe("MemorySubscriptionRepository", () => {
  it("breaks tied order timestamps by id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
    try {
      const repository = new MemorySubscriptionRepository();
      const base = {
        workspaceId: "ws_subscription_ties",
        planCode: "starter",
        planName: "Starter",
        billingCycle: "monthly" as const,
        priceCny: 99,
        includedStores: 2,
        includedTasks: 100,
        paymentProvider: "pending_provider",
      };
      await repository.createOrder({ ...base, idempotencyKey: "tie-a" });
      await repository.createOrder({ ...base, idempotencyKey: "tie-b" });

      const orders = await repository.listOrders(base.workspaceId);
      expect(orders.map((order) => order.createdAt)).toEqual([
        "2026-10-10T00:00:00.000Z",
        "2026-10-10T00:00:00.000Z",
      ]);
      expect(orders.map((order) => order.id)).toEqual(
        [...orders.map((order) => order.id)].sort((a, b) => b.localeCompare(a)),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when an order omits its idempotency key", async () => {
    const repository = new MemorySubscriptionRepository();
    await expect(
      repository.createOrder({
        workspaceId: "ws_subscription",
        planCode: "starter",
        planName: "Starter",
        billingCycle: "monthly",
        priceCny: 99,
        includedStores: 2,
        includedTasks: 100,
        paymentProvider: "pending_provider",
        idempotencyKey: "   ",
      }),
    ).rejects.toThrow("SUBSCRIPTION_ORDER_IDEMPOTENCY_KEY_REQUIRED");
  });

  it("retrieves an older order directly by order number after more than 100 newer orders", async () => {
    const repository = new MemorySubscriptionRepository();
    const first = await repository.createOrder({
      workspaceId: "ws_subscription",
      planCode: "starter",
      planName: "Starter",
      billingCycle: "monthly",
      priceCny: 99,
      includedStores: 2,
      includedTasks: 100,
      paymentProvider: "pending_provider",
      idempotencyKey: "oldest-key",
    });
    for (let index = 0; index < 101; index += 1) {
      await repository.createOrder({
        workspaceId: "ws_subscription",
        planCode: "starter",
        planName: "Starter",
        billingCycle: "monthly",
        priceCny: 99,
        includedStores: 2,
        includedTasks: 100,
        paymentProvider: "pending_provider",
        idempotencyKey: `newer-key-${index}`,
      });
    }

    await expect(
      repository.getOrderByOrderNo("ws_subscription", first.orderNo),
    ).resolves.toMatchObject({ id: first.id, orderNo: first.orderNo });
  });

  it("rejects idempotency reuse for a different subscription intent", async () => {
    const repository = new MemorySubscriptionRepository();
    const input = {
      workspaceId: "ws_subscription",
      planCode: "starter",
      planName: "Starter",
      billingCycle: "monthly" as const,
      priceCny: 99,
      includedStores: 2,
      includedTasks: 100,
      paymentProvider: "pending_provider",
      idempotencyKey: "sub-key",
    };
    await repository.createOrder(input);

    await expect(
      repository.createOrder({
        ...input,
        planCode: "pro",
        planName: "Pro",
        priceCny: 299,
      }),
    ).rejects.toBeInstanceOf(SubscriptionOrderIdempotencyConflictError);
  });

  it("rejects idempotency reuse by a different authenticated member", async () => {
    const repository = new MemorySubscriptionRepository();
    const input = {
      workspaceId: "ws_subscription",
      planCode: "starter",
      planName: "Starter",
      billingCycle: "monthly" as const,
      priceCny: 99,
      includedStores: 2,
      includedTasks: 100,
      paymentProvider: "pending_provider",
      createdByActorId: "actor_a",
      idempotencyKey: "member-key",
    };
    await repository.createOrder(input);

    await expect(
      repository.createOrder({ ...input, createdByActorId: "actor_b" }),
    ).rejects.toBeInstanceOf(SubscriptionOrderIdempotencyConflictError);
  });
});
