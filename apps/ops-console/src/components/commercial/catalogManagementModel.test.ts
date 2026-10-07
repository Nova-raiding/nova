import { describe, expect, it } from "vitest";
import { catalogPriceYuan, catalogProductRows, loadAllBenefitBundlePages } from "./catalogManagementModel.js";

const bundle = (code: string, versionId: string) => ({ code, versionId } as any);

describe("catalog management model", () => {
  it("loads cursor pages completely and rejects incomplete or looping results", async () => {
    const calls: unknown[] = [];
    const result = await loadAllBenefitBundlePages(async (input) => {
      calls.push(input);
      return input.cursor
        ? { items: [bundle("starter", "v2")], total: 2 }
        : { items: [bundle("starter", "v1")], total: 2, nextCursor: "next" };
    });
    expect(result).toHaveLength(2);
    expect(calls).toEqual([{ limit: 100 }, { limit: 100, cursor: "next" }]);

    await expect(loadAllBenefitBundlePages(async () => ({ items: [], total: 1, truncated: true }))).rejects.toThrow("结果不完整");
    await expect(loadAllBenefitBundlePages(async () => ({ items: [bundle("x", "v1")], total: 1, nextCursor: "same" }))).rejects.toThrow("分页游标重复");
  });

  it("uses the server sale projection and keeps ambiguous versions unknown", () => {
    const rows = catalogProductRows([
      { id: "starter-v1", skuCode: "starter", version: "v1", approvalState: "approved", saleRevision: 1, currentSaleState: "off_sale" },
      { id: "starter-v2", skuCode: "starter", version: "v2", approvalState: "approved", saleRevision: 2, currentSaleState: "on_sale", currentSaleVersionId: "starter-v2" },
    ] as any);
    expect(rows[0]).toMatchObject({ code: "starter", latest: { id: "starter-v2" }, current: { id: "starter-v2" }, saleState: "on_sale" });
    expect(catalogPriceYuan({ priceFen: 1234, priceLabel: "invalid" })).toBe(12.34);
    expect(catalogPriceYuan({ priceFen: Number.NaN, priceLabel: " ¥ 9.50 " })).toBe(9.5);
  });
});
