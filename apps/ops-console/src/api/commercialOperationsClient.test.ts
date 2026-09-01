import { describe, expect, it } from "vitest";
import {
  parseAccessBlocks,
  parseCatalog,
  parseCommercialAccessSummary,
  parseLedger,
} from "./commercialOperationsClient.js";

describe("commercial operations DTO parsers", () => {
  it("preserves an unknown balance instead of manufacturing zero", () => {
    const result = parseCommercialAccessSummary({
      decision_id: "cad_1", workspace_id: "ws_1", balance_state: "unknown",
      available_points: null, reserved_points: null, allowed: false,
      error_code: "CREATIVE_POINTS_UNAVAILABLE", access_revision: null,
    });
    expect(result.availablePoints).toBeNull();
    expect(result.balanceState).toBe("unknown");
    expect(result.errorCode).toBe("CREATIVE_POINTS_UNAVAILABLE");
  });

  it("rejects malformed success payloads instead of showing an empty state", () => {
    expect(() => parseAccessBlocks({ total: 1 })).toThrow("items 必须是对象数组");
    expect(() => parseLedger({ items: [{ id: "ledger_1" }] })).toThrow("返回无法识别的商业运营数据");
  });

  it("keeps private visibility explicit for the permission boundary", () => {
    const result = parseCatalog({ items: [{
      id: "sku_1", sku_code: "private_test", name: "非公开测试", type: "trial",
      visibility: "private", version: "v1", price_label: "服务端价格",
      benefits_summary: "服务端权益", approval_state: "draft",
    }] });
    expect(result.items[0]?.visibility).toBe("private");
  });
});
