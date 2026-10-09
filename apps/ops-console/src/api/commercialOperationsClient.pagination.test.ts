import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./opsClient.js", () => ({ rpc }));

import { commercialOperationsClient, parseAccessBlocks, parseBenefitBundles, parseEntitlements, parseOrders } from "./commercialOperationsClient.js";

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

  it("preserves the verified entitlement source order facts", () => {
    expect(parseEntitlements({ items: [{
      id: "ent_1", workspace_id: "ws_1", sku_code: "growth", snapshot_version: "v1", status: "active",
      source_order_id: "order_1", source_order_status: "paid",
    }] }).items[0]).toMatchObject({ sourceOrderId: "order_1", sourceOrderStatus: "paid" });
  });

  it("parses versioned benefit bundles and rejects invalid lifecycle payloads", () => {
    const bundle = {
      id: "bundle-1", code: "creative", version_id: "bundle-1-v1", version: 1, revision: 4,
      name: "创意权益包", usage: "included", lifecycle: "approved", state: "active",
      benefits: [{ code: "creative_points", quantity: 500 }], payload: { policyRef: "points-v1" }, checksum: "sha256:abc",
    };
    expect(parseBenefitBundles({ items: [bundle], total: 1 }).items[0]).toMatchObject({
      id: "bundle-1", versionId: "bundle-1-v1", revision: 4, usage: "included", lifecycle: "approved", state: "active",
    });
    expect(() => parseBenefitBundles({ items: [{ ...bundle, usage: "monthly" }], total: 1 })).toThrow("usage无效");
    expect(() => parseBenefitBundles({ items: [{ ...bundle, revision: -1 }], total: 1 })).toThrow("版本或revision无效");
  });

  it("preserves the benefit-bundle reference cursor and returns completeness metadata", async () => {
    rpc.mockResolvedValue({ items: [{ sku_code: "growth", sku_version_id: "growth-v1" }], total: 3, next_cursor: "references-next", truncated: true });
    await expect(commercialOperationsClient.benefitBundleReferences("benefit-core", "benefit-v1", { limit: 2, cursor: "references-first" })).resolves.toMatchObject({
      items: [{ sku_code: "growth", sku_version_id: "growth-v1" }], total: 3, nextCursor: "references-next", truncated: true,
    });
    expect(rpc).toHaveBeenCalledWith("ops.commercial.benefit-bundles.references.list", {
      code: "benefit-core", version_id: "benefit-v1", limit: "2", cursor: "references-first",
    }, { signal: undefined });
  });

  it("requests commercial timeline pages using the supported limit and preserves continuation metadata", async () => {
    rpc.mockResolvedValue({ items: [], total: 101, next_cursor: "timeline-next", truncated: true, source_truncated: true });
    await expect(commercialOperationsClient.timeline("ws-1", { limit: 100, cursor: "timeline-first" })).resolves.toMatchObject({
      items: [], total: 101, nextCursor: "timeline-next", truncated: true, sourceTruncated: true,
    });
    await commercialOperationsClient.timeline("ws-1");
    expect(rpc).toHaveBeenCalledWith("ops.commercial.timeline.list", {
      target_workspace_id: "ws-1", limit: "100", cursor: "timeline-first",
    }, { signal: undefined });
    expect(rpc).toHaveBeenLastCalledWith("ops.commercial.timeline.list", { target_workspace_id: "ws-1", limit: "100" }, { signal: undefined });
  });

  it("requests refund event cursor pages and preserves the total and continuation", async () => {
    rpc.mockResolvedValue({ items: [], total: 101, next_cursor: "refund-next", truncated: true });
    await expect(commercialOperationsClient.listCommercialRefunds("ws-1", { limit: 100, cursor: "refund-first" })).resolves.toMatchObject({ total: 101, nextCursor: "refund-next", truncated: true });
    expect(rpc).toHaveBeenCalledWith("ops.commercial.order.refund.list", { target_workspace_id: "ws-1", limit: "100", cursor: "refund-first" }, { signal: undefined });
  });
});
