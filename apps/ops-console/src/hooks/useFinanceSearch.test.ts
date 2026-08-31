import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceSearchRecord } from "../../../../packages/contracts/src/ops/finance-search.js";
import { financeSearchClient } from "../api/opsDomainClients.js";
import { financeErrorMessage, LatestFinanceRequest, mergeFinanceRecords } from "./useFinanceSearch.js";

const record = (id: string): FinanceSearchRecord => ({ id, kind: "wallet_transaction", workspaceId: "ws_a", status: "debit", label: "钱包流水", occurredAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z", version: id, redacted: true });

describe("finance search hook helpers", () => {
  it("keeps cursor append idempotent when a page is retried", () => {
    expect(mergeFinanceRecords([record("1")], [record("1"), record("2")]).map(item => item.id)).toEqual(["1", "2"]);
  });

  it("aborts the previous request and rejects stale responses", () => {
    const requests = new LatestFinanceRequest();
    const first = requests.begin();
    const second = requests.begin();

    expect(first.signal.aborted).toBe(true);
    expect(requests.isCurrent(first.id)).toBe(false);
    expect(requests.isCurrent(second.id)).toBe(true);

    requests.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(requests.isCurrent(second.id)).toBe(false);
  });

  it("preserves actionable API errors and supplies a safe fallback", () => {
    expect(financeErrorMessage(new Error("params.limit must be a non-empty string"), "fallback"))
      .toBe("params.limit must be a non-empty string");
    expect(financeErrorMessage({ code: "INVALID_REQUEST" }, "财务记录加载失败，请重试。"))
      .toBe("财务记录加载失败，请重试。");
  });
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
};

const financeRecord = { id: "order-1", kind: "recharge_order", workspaceId: "ws-1", status: "paid", label: "充值订单", occurredAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", version: "version-1", redacted: true } as const;
const financePage = {
  records: [] as typeof financeRecord[],
  summary: { totalRecords: 0, rechargeOrderCny: 0, subscriptionOrderCny: 0, walletCreditCny: 0, walletDebitCny: 0, walletNetCny: 0, providerCostCny: 0, customerChargeCny: 0, usageUnits: 0, byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } },
  snapshotAt: "2026-08-29T00:00:00.000Z",
  scope: { role: "platform_ops", workspaceCount: 0 },
};

afterEach(() => vi.unstubAllGlobals());

describe("canonical finance client wire format", () => {
  it("serializes the default search query using the MCP string envelope", async () => {
    const storage = memoryStorage();
    storage.setItem("ops_api_base", "http://ops.test");
    storage.setItem("ops_workspace_id", "ws-operator");
    storage.setItem("ops_api_token", "test-token");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "response-id",
      result: {
        records: [],
        summary: financePage.summary,
        snapshotAt: "2026-08-29T00:00:00.000Z",
        scope: { role: "platform_ops", workspaceCount: 0 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", fetchMock);

    await financeSearchClient.search({ limit: 50 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({
      jsonrpc: "2.0",
      id: expect.any(String),
      method: "ops.finance.search",
      params: { limit: "50" },
    });
  });

  it("keeps search, detail, and export parameters inside the server contract", async () => {
    const storage = memoryStorage();
    storage.setItem("ops_api_base", "http://ops.test");
    storage.setItem("ops_workspace_id", "ws-operator");
    storage.setItem("ops_api_token", "test-token");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      const result = method === "ops.finance.search" ? financePage
        : method === "ops.finance.detail" ? { ...financeRecord, attributes: {} }
          : { exportId: "export-1", fileName: "finance.csv", contentType: "text/csv; charset=utf-8", csv: "id\norder-1", rowCount: 1, truncated: false, snapshotAt: financePage.snapshotAt };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "response-id", result }), { status: 200 });
    });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", fetchMock);
    const query = {
      workspaceIds: ["ws-1", "ws-2"],
      kinds: ["recharge_order" as const],
      statuses: ["paid"],
      text: "order",
      fromAt: "2026-08-01T00:00:00.000Z",
      toAt: "2026-08-29T00:00:00.000Z",
      cursor: "finance-cursor",
      snapshotAt: "2026-08-29T01:00:00.000Z",
      limit: 100,
    };

    await financeSearchClient.search(query);
    await financeSearchClient.detail({
      workspaceId: "ws-1",
      kind: "recharge_order",
      id: "order-1",
      expectedVersion: "version-1",
      snapshotAt: query.snapshotAt,
    });
    await financeSearchClient.exportCsv(query);

    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)) as {
      method: string;
      params: Record<string, string>;
    });
    expect(requests).toEqual([
      {
        jsonrpc: "2.0", id: expect.any(String), method: "ops.finance.search",
        params: {
          workspace_ids_json: '["ws-1","ws-2"]', kinds_json: '["recharge_order"]',
          statuses_json: '["paid"]', text: "order", from_at: query.fromAt,
          to_at: query.toAt, cursor: "finance-cursor", snapshot_at: query.snapshotAt,
          limit: "100",
        },
      },
      {
        jsonrpc: "2.0", id: expect.any(String), method: "ops.finance.detail",
        params: {
          target_workspace_id: "ws-1", kind: "recharge_order", record_id: "order-1",
          expected_version: "version-1", snapshot_at: query.snapshotAt,
        },
      },
      {
        jsonrpc: "2.0", id: expect.any(String), method: "ops.finance.export",
        params: {
          workspace_ids_json: '["ws-1","ws-2"]', kinds_json: '["recharge_order"]',
          statuses_json: '["paid"]', text: "order", from_at: query.fromAt,
          to_at: query.toAt, snapshot_at: query.snapshotAt, limit: "100",
        },
      },
    ]);
    expect(requests.every(request => Object.values(request.params).every(value => typeof value === "string" && value.length > 0))).toBe(true);
  });
});
