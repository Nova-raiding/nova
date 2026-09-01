import { describe, expect, it } from "vitest";
import { commercialViewUrl, readCommercialTargetWorkspace, readCommercialView } from "./useCommercialOperations.js";
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
});
