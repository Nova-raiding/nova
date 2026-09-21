import { describe, expect, it } from "vitest";
import { catalogPriceYuan } from "./FinancePage.js";

describe("catalogPriceYuan", () => {
  it("uses the exact integer-fen amount instead of reparsing a localized label", () => {
    expect(catalogPriceYuan({ priceFen: 199_900, priceLabel: "¥1,999.00" })).toBe(1999);
  });

  it("supports legacy labels with thousands separators when priceFen is absent", () => {
    expect(catalogPriceYuan({ priceLabel: "¥ 5,000.50 / 月" })).toBe(5000.5);
  });

  it("fails closed to zero for an unresolved legacy price", () => {
    expect(catalogPriceYuan({ priceFen: null, priceLabel: "价格未决" })).toBe(0);
  });
});
