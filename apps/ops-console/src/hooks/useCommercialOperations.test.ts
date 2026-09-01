import { describe, expect, it } from "vitest";
import { commercialViewUrl, readCommercialView } from "./useCommercialOperations.js";

describe("commercial operations deep links", () => {
  it("defaults invalid or missing views to the recovery queue", () => {
    expect(readCommercialView("")).toBe("blocks");
    expect(readCommercialView("?view=legacy-wallet")).toBe("blocks");
  });

  it("preserves unrelated scope filters while switching task views", () => {
    expect(commercialViewUrl({ pathname: "/ops/finance", search: "?workspace=ws_1&record=old", hash: "" }, "ledger"))
      .toBe("/ops/finance?workspace=ws_1&view=ledger");
  });
});
