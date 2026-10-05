import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("../../api/opsClient.js", () => ({ rpc: rpcMock }));

import { commercialOperationsClient } from "../../api/commercialOperationsClient.js";

beforeEach(() => rpcMock.mockReset());

describe("platform catalog server pagination", () => {
  it("preserves cursor, search, type, status, limit, and public visibility in the real list contract", async () => {
    rpcMock.mockResolvedValueOnce({ items: [], total: 0, next_cursor: null });

    const page = await commercialOperationsClient.catalogManagement({
      cursor: "cursor-next-page",
      limit: 40,
      kind: "monthly",
      saleState: "on_sale",
      search: "  growth plan  ",
    });

    expect(page).toMatchObject({ items: [], total: 0, nextCursor: null });
    expect(rpcMock).toHaveBeenCalledWith("ops.commercial.catalog-v2.list", {
      include_private: "false",
      limit: "40",
      cursor: "cursor-next-page",
      kind: "monthly",
      sale_state: "on_sale",
      search: "growth plan",
    }, { signal: undefined });
  });

  it("rejects an invalid server page size before issuing a request", async () => {
    await expect(commercialOperationsClient.catalogManagement({ limit: 101 })).rejects.toThrow("1 到 100");
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
