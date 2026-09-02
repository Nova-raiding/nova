import { describe, expect, it } from "vitest";
import { commercialQueryUrl, commercialViewUrl, readCommercialQuery, readCommercialTargetWorkspace, readCommercialView } from "./useCommercialOperations.js";
import type { AuthorizationProjection } from "../authz/authorization.js";

describe("commercial operations deep links", () => {
  it("defaults invalid or missing views to the recovery queue", () => {
    expect(readCommercialView("")).toBe("blocks");
    expect(readCommercialView("?view=legacy-wallet")).toBe("blocks");
  });

  it("uses the explicit workspace deep-link for platform commercial reads", () => {
    const authorization = { scope: { kind: "platform" } } as AuthorizationProjection;
    expect(readCommercialTargetWorkspace("?workspace=ws_target&view=ledger", authorization)).toBe("ws_target");
  });

  it("falls back to the verified workspace scope when the deep-link omits it", () => {
    const authorization = { scope: { kind: "workspace", id: "ws_verified" } } as AuthorizationProjection;
    expect(readCommercialTargetWorkspace("?view=ledger", authorization)).toBe("ws_verified");
  });

  it("preserves unrelated scope filters while switching task views", () => {
    expect(commercialViewUrl({ pathname: "/ops/finance", search: "?workspace=ws_1&record=old", hash: "" }, "ledger"))
      .toBe("/ops/finance?workspace=ws_1&view=ledger");
  });

  it("restores the complete desktop workbench context from the URL", () => {
    expect(readCommercialQuery("?view=orders&workspace=ws_1&record=ord_1&status=paid&q=sku&page=3&sort=createdAt&order=descend"))
      .toEqual({ view: "orders", record: "ord_1", status: "paid", query: "sku", page: 3, sort: "createdAt", order: "descend" });
  });

  it("writes filters sorting pagination and drawer target without losing workspace scope", () => {
    expect(commercialQueryUrl(
      { pathname: "/ops/finance", search: "?workspace=ws_1&view=blocks", hash: "" },
      { record: "decision_1", status: "UNAVAILABLE", query: "req_1", page: 2, sort: "occurredAt", order: "descend" },
    )).toBe("/ops/finance?workspace=ws_1&view=blocks&record=decision_1&status=UNAVAILABLE&q=req_1&sort=occurredAt&order=descend&page=2");
  });

  it("normalizes invalid pagination and sorting rather than trusting the deep link", () => {
    expect(readCommercialQuery("?view=ledger&page=-4&order=sideways")).toMatchObject({ view: "ledger", page: 1, order: "" });
  });
});
