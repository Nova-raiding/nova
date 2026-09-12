import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentCommercialCatalog, formatOverviewMoney, planDistribution } from "../components/sections/overview/CommercialOverviewSection.js";

const overviewSource = readFileSync(new URL("./OverviewPage.tsx", import.meta.url), "utf8");

describe("commercial overview helpers", () => {
  it("does not turn missing money into zero", () => {
    expect(formatOverviewMoney(undefined)).toBe("—");
  });

  it("formats money with two decimal places", () => {
    expect(formatOverviewMoney(1234.5)).toBe("¥1234.50");
  });

  it("counts the visible workspace rows by plan", () => {
    expect(
      planDistribution([
        { workspaceId: "ws_1", planName: "Starter", subscriptionStatus: "trialing", monthlyPriceCny: 199, memberCount: 0, status: "active", usedTasks: 0, includedTasks: 10 },
        { workspaceId: "ws_2", planName: "Starter", subscriptionStatus: "trialing", monthlyPriceCny: 199, memberCount: 0, status: "active", usedTasks: 0, includedTasks: 10 },
        { workspaceId: "ws_3", planName: "Pro", subscriptionStatus: "active", monthlyPriceCny: 499, memberCount: 2, status: "active", usedTasks: 0, includedTasks: 50 },
      ]),
    ).toEqual([
      { name: "Starter", count: 2 },
      { name: "Pro", count: 1 },
    ]);
  });

  it("shows one current commercial version per SKU and prefers an approved version", () => {
    expect(
      currentCommercialCatalog([
        { id: "basic-v1", skuCode: "basic", name: "basic", type: "monthly", visibility: "public", version: "v1", priceLabel: "¥2000.00", cycleLabel: null, benefitsSummary: "旧权益", approvalState: "draft", validFrom: null, validTo: null, unresolved: ["STORAGE_UNIT_UNRESOLVED"] },
        { id: "basic-v2", skuCode: "basic", name: "basic", type: "monthly", visibility: "public", version: "v2", priceLabel: "¥2000.00", cycleLabel: null, benefitsSummary: "当前权益", approvalState: "approved", validFrom: "2026-09-08T00:00:00.000Z", validTo: null, unresolved: [] },
        { id: "growth-v3", skuCode: "growth", name: "growth", type: "monthly", visibility: "public", version: "v3", priceLabel: "¥5000.00", cycleLabel: null, benefitsSummary: "待批准", approvalState: "draft", validFrom: null, validTo: null, unresolved: ["ORDER_TERMS_REQUIRED"] },
      ]),
    ).toMatchObject([
      { skuCode: "basic", version: "v2", benefitsSummary: "当前权益" },
      { skuCode: "growth", version: "v3" },
    ]);
  });
});

describe("overview page structure", () => {
  it("does not reintroduce the removed page header banner", () => {
    expect(overviewSource).not.toContain("OpsPageError");
    expect(overviewSource).not.toContain("当前工作区数据");
    expect(overviewSource).not.toContain("刷新总览");
    expect(overviewSource).not.toContain("首屏查看平台规模");
    expect(overviewSource).not.toContain('eyebrow="OVERVIEW"');
  });
});
