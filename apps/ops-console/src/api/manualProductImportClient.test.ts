import { afterEach, describe, expect, it, vi } from "vitest";
import { importManualProducts, type ManualProductImportInput } from "./manualProductImportClient.js";
import { rpcForWorkspace } from "./opsClient.js";

vi.mock("./opsClient.js", () => ({ rpcForWorkspace: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const input = (overrides: Partial<ManualProductImportInput> = {}): ManualProductImportInput => ({
  workspaceId: "ws_demo", platform: "jd", accountId: "store_demo", products: [{ title: "QA 商品" }],
  sourceRef: "商家提供文件 #42", sourceSha256: "a".repeat(64), reason: "按商家要求导入",
  mismatchedCount: 0, confirmationCount: 0, assignmentConfirmed: false, containsAssetRefs: false,
  ...overrides,
});

describe("manual product import API contract", () => {
  it("writes only to the explicit workspace/store and validates a complete response", async () => {
    vi.mocked(rpcForWorkspace).mockResolvedValue({ result: { count: 1, products: [{ id: "product-1" }] } });
    await expect(importManualProducts(input())).resolves.toEqual({ count: 1, products: [{ id: "product-1" }] });
    expect(rpcForWorkspace).toHaveBeenCalledExactlyOnceWith("ws_demo", "ops.platform.product.import.batch", {
      workspace_id: "ws_demo", platform: "jd", account_id: "store_demo", products_json: '[{"title":"QA 商品"}]',
      source_ref: "商家提供文件 #42", source_sha256: "a".repeat(64), reason: "按商家要求导入",
    }, { timeoutMs: 120_000 });
  });

  it("requires explicit assignment evidence for rows the source did not scope", async () => {
    vi.mocked(rpcForWorkspace).mockResolvedValue({ result: { count: 1, products: [{ id: "product-1" }] } });
    await expect(importManualProducts(input({ confirmationCount: 1 }))).rejects.toThrow("请先确认商品归属");
    expect(rpcForWorkspace).not.toHaveBeenCalled();
    await importManualProducts(input({ confirmationCount: 1, assignmentConfirmed: true }));
    expect(rpcForWorkspace).toHaveBeenCalledWith("ws_demo", "ops.platform.product.import.batch", expect.objectContaining({ store_assignment_confirmed: "true" }), expect.anything());
  });

  it.each([
    { workspaceId: "" }, { accountId: "" }, { mismatchedCount: 1 }, { containsAssetRefs: true },
    { sourceRef: " " }, { sourceSha256: "bad" }, { reason: " " }, { products: [] },
    { products: Array.from({ length: 51 }, () => ({ title: "x" })) },
  ])("rejects unsafe or incomplete import input before the RPC: %j", async override => {
    await expect(importManualProducts(input(override))).rejects.toThrow();
    expect(rpcForWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { result: { count: 0, products: [] } },
    { result: { count: 1, products: [] } },
    { result: { count: 1, products: [{}] } },
    { result: { count: 2, products: [{ id: "one" }] } },
  ])("fails closed on an incomplete service receipt: %j", async response => {
    vi.mocked(rpcForWorkspace).mockResolvedValue(response);
    await expect(importManualProducts(input())).rejects.toThrow("不要重复提交");
  });
});
