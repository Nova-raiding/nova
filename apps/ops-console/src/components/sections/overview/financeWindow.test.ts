import { describe, expect, it } from "vitest";
import { dashboardMonthLabel, formatOverviewCurrency, platformMonthlyFinanceRequest, shanghaiMonthWindow } from "./financeWindow.js";

describe("shanghaiMonthWindow", () => {
  it("uses the Shanghai calendar month even when UTC is still in the prior month", () => {
    expect(shanghaiMonthWindow(new Date("2026-08-31T17:00:00.000Z"))).toEqual({
      from_at: "2026-09-01T00:00:00+08:00",
      to_at: "2026-08-31T17:00:00.000Z",
      label: "2026年9月",
    });
  });

  it("handles year boundaries and rejects invalid dates", () => {
    expect(shanghaiMonthWindow(new Date("2026-12-31T16:30:00.000Z")).from_at)
      .toBe("2027-01-01T00:00:00+08:00");
    expect(() => shanghaiMonthWindow(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("binds the displayed month and exact paid-order query to the same timestamp", () => {
    expect(platformMonthlyFinanceRequest(new Date("2026-08-31T17:00:00.000Z"))).toEqual({
      label: "2026年9月",
      params: {
        kinds_json: '["recharge_order","subscription_order"]',
        statuses_json: '["paid"]',
        from_at: "2026-09-01T00:00:00+08:00",
        to_at: "2026-08-31T17:00:00.000Z",
        limit: "1",
      },
    });
  });
});

describe("dashboardMonthLabel", () => {
  it("uses the compact month shown by the desktop reference", () => {
    expect(dashboardMonthLabel("2026年9月")).toBe("9月");
    expect(dashboardMonthLabel(undefined, new Date("2026-08-31T17:00:00.000Z"))).toBe("9月");
  });
});

describe("formatOverviewCurrency", () => {
  it("matches the compact screenshot format for whole yuan and retains cents", () => {
    expect(formatOverviewCurrency(0)).toBe("0");
    expect(formatOverviewCurrency(1288)).toBe("1288");
    expect(formatOverviewCurrency(12.34)).toBe("12.34");
  });

  it("does not render non-finite values as money", () => {
    expect(formatOverviewCurrency(Number.NaN)).toBe("—");
    expect(formatOverviewCurrency(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
