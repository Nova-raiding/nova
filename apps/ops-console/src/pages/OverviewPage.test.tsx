import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentCommercialCatalog, formatOverviewMoney, planDistribution } from "../components/sections/overview/CommercialOverviewSection.js";
import { commercialBenefitOptions, readableBenefitItems, readableBenefits } from "../components/commercial/benefitLabels.js";

const overviewSource = readFileSync(new URL("./OverviewPage.tsx", import.meta.url), "utf8");
const commercialOverviewSource = readFileSync(new URL("../components/sections/overview/CommercialOverviewSection.tsx", import.meta.url), "utf8");

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

  it("translates persisted benefit keys into operator-facing Chinese", () => {
    expect(readableBenefits({
      id: "basic-v2", skuCode: "basic", name: "基础版", type: "monthly", visibility: "public", version: "v2",
      priceLabel: "¥2000.00", cycleLabel: "每月", benefitsSummary: "creative_points:5000 点/月；cloud_storage:50 GB_DECIMAL",
      approvalState: "approved", validFrom: "2026-09-08T00:00:00.000Z", validTo: null, unresolved: [],
    })).toBe("创意点：5000 点/月 · 共享存储：50 GB");
  });

  it("provides Chinese benefit choices and separate readable rows for operators", () => {
    expect(commercialBenefitOptions).toContainEqual({ code: "cloud_storage", label: "共享存储", defaultUnit: "GB" });
    expect(readableBenefitItems({
      id: "growth-v1", skuCode: "growth", name: "成长版", type: "monthly", visibility: "public", version: "v1",
      priceLabel: "¥5000.00", cycleLabel: "每月", benefitsSummary: "creative_points:2000 creative_points；max_stores:5 store",
      approvalState: "approved", validFrom: "2026-09-08T00:00:00.000Z", validTo: null, unresolved: [],
    })).toEqual(["创意点：2000 点", "店铺数：5 家店铺"]);
  });

  it("explains empty persisted benefits in operator language", () => {
    expect(readableBenefits({
      id: "custom-v1", skuCode: "custom", name: "定制版", type: "monthly", visibility: "public", version: "v1",
      priceLabel: "价格未决", cycleLabel: "按合同", benefitsSummary: "无已持久化权益项",
      approvalState: "draft", validFrom: null, validTo: null, unresolved: [],
    })).toBe("暂未配置套餐权益（请编辑补充）");
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

  it("renders the tenant ledger with row-level authorization and finance navigation", () => {
    expect(overviewSource).toContain("<CommercialOverviewSection");
    expect(commercialOverviewSource).toContain('onNavigateWithQuery?.("finance", { workspace: workspaceId })');
    expect(commercialOverviewSource).toContain("查看财务");
    expect(commercialOverviewSource).not.toContain("给企业授权</Button>");
  });
});
