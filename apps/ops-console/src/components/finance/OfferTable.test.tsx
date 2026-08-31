import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { offerChangeErrors, type OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import type { Offer } from "../../types/ops.js";
import { OfferTable, offerDateTimeInputValue, offerDateTimeIsoValue } from "./OfferTable.js";

const offer: Offer = {
  id: "offer_1",
  code: "starter",
  name: "Starter",
  billingCycle: "monthly",
  priceCny: 199,
  includedStores: 1,
  includedTasks: 30,
  active: true,
  validFrom: "2026-09-01T00:00:00.000Z",
  validTo: "2027-09-01T00:00:00.000Z",
  revision: 7,
};

describe("OfferTable", () => {
  it("renders validity and operator reason controls", () => {
    const model = { offers: [offer], setOffers: vi.fn(), canGlobalCommercial: true, saveOffer: vi.fn() } as unknown as OpsConsoleModel;
    const html = renderToStaticMarkup(<OfferTable model={model} />);
    expect(html).toContain("生效时间");
    expect(html).toContain("失效时间（可选）");
    expect(html).toContain("变更原因");
    expect(html).toContain('aria-label="starter 生效时间"');
    expect(html).toContain("必填，写入操作审计");
  });

  it("rejects missing reasons and invalid date ranges before submission", () => {
    expect(offerChangeErrors(offer)).toEqual({ reason: "请输入本次套餐变更原因" });
    expect(offerChangeErrors({ ...offer, changeReason: "季度调价", validTo: "2026-08-01T00:00:00.000Z" })).toEqual({ validTo: "失效时间必须晚于生效时间" });
    expect(offerChangeErrors({ ...offer, changeReason: "季度调价" })).toEqual({});
  });

  it("round-trips date-time inputs without silently changing the instant", () => {
    const iso = "2026-09-01T00:00:00.000Z";
    expect(offerDateTimeIsoValue(offerDateTimeInputValue(iso))).toBe(iso);
    expect(offerDateTimeIsoValue("")).toBeUndefined();
  });
});
