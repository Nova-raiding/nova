import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./opsClient.js", () => ({ rpc }));

import { commercialOperationsClient, parseAccessBlocks, parseEntitlements, parseOrders } from "./commercialOperationsClient.js";

describe("commercial operations pagination contract", () => {
  beforeEach(() => rpc.mockReset());

  it("passes opaque cursors and preserves total/continuation metadata for bounded lists", async () => {
    rpc.mockResolvedValue({ items: [], total: 101, next_cursor: "page-2", truncated: true });

    await commercialOperationsClient.blocks("ws-1", { limit: 100, cursor: "page-1" });
    await commercialOperationsClient.entitlements("ws-1", { limit: 100, cursor: "page-1" });
    await commercialOperationsClient.orders("ws-1", { limit: 100, cursor: "page-1" });

    expect(rpc.mock.calls.map(([method, params]) => ({ method, params }))).toEqual([
      { method: "ops.commercial.access-blocks.list", params: { target_workspace_id: "ws-1", status: "open", limit: "100", cursor: "page-1" } },
      { method: "ops.commercial.entitlements.list", params: { target_workspace_id: "ws-1", limit: "100", cursor: "page-1" } },
      { method: "ops.commercial.orders-v2.list", params: { target_workspace_id: "ws-1", limit: "100", cursor: "page-1" } },
    ]);
  });

  it("rejects an incomplete total when the server provides neither truncation nor a cursor", () => {
    const response = { items: [], total: 2, next_cursor: null };
    expect(() => parseAccessBlocks(response)).toThrow("没有分页继续证据");
  });

  it("keeps an explicit server truncation visible to the UI model", () => {
    const response = { items: [], total: 100, next_cursor: null, truncated: true };
    expect(parseAccessBlocks(response)).toMatchObject({ total: 100, truncated: true, nextCursor: null });
    expect(parseEntitlements(response)).toMatchObject({ total: 100, truncated: true, nextCursor: null });
    expect(parseOrders(response)).toMatchObject({ total: 100, truncated: true, nextCursor: null });
  });
});
