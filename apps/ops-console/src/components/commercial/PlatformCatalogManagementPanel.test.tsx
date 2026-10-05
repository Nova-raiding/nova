import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CommercialCatalogItem } from "../../api/commercialOperationsClient.js";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { catalogProductRows, loadAllBenefitBundlePages, mergeBenefitBundleVersions } from "./catalogManagementModel.js";
import { catalogPolicyPatch, mutateCatalogAndStartRefresh, PlatformCatalogManagementPanel } from "./PlatformCatalogManagementPanel.js";
import { encodeBenefits } from "./RegisteredBenefitFields.js";

const version = (id: string, v: number, overrides: Partial<CommercialCatalogItem> = {}): CommercialCatalogItem => ({ id, skuCode: "basic", name: "基础版", type: "monthly", visibility: "public", version: `v${v}`, priceLabel: "¥2,000.00", priceFen: 200000, cycleLabel: "1 自然月", benefitsSummary: "创意点", approvalState: "approved", executable: true, validFrom: null, validTo: null, unresolved: [], currentSaleState: "on_sale", currentSaleVersionId: "sold-v1", saleRevision: 3, ...overrides });
const model = (items: CommercialCatalogItem[], capabilities: string[] = [], error?: string) => ({ platformCommercialCatalog: items, loading: false, dataSetError: () => error, load: vi.fn(), authorization: { can: (capability: string) => capabilities.includes(capability) } }) as unknown as OpsConsoleModel;

describe("catalog sale projection boundary", () => {
  it("keeps the current sold price when a newer draft exists", () => {
    const rows = catalogProductRows([version("sold-v1", 1), version("draft-v3", 3, { approvalState: "draft", executable: false, priceFen: 250000, priceLabel: "¥2,500.00" })]);
    expect(rows[0]?.current?.id).toBe("sold-v1");
    expect(rows[0]?.latest.id).toBe("draft-v3");
    expect(rows[0]?.current?.priceFen).toBe(200000);
  });
  it("does not revive historical approved versions after retirement", () => {
    const rows = catalogProductRows([version("sold-v1", 1, { currentSaleState: "off_sale", currentSaleVersionId: null }), version("retired-v4", 4, { approvalState: "retired", executable: false, currentSaleState: "off_sale", currentSaleVersionId: null })]);
    expect(rows[0]?.current).toBeUndefined();
    expect(rows[0]?.saleState).toBe("off_sale");
  });
  it("fails closed when the current pointer or projection is missing", () => {
    expect(catalogProductRows([version("history-v1", 1)])[0]?.saleState).toBe("unknown");
    expect(catalogProductRows([version("sold-v1", 1, { currentSaleState: undefined, saleRevision: undefined })])[0]?.current).toBeUndefined();
  });
});
describe("desktop catalog authorization and error states", () => {
  it("shows sale and draft prices separately without a combined delete/retire action", () => {
    const html = renderToStaticMarkup(<PlatformCatalogManagementPanel model={model([version("sold-v1", 1), version("draft-v3", 3, { approvalState: "draft", executable: false, priceLabel: "¥2,500.00" })])} />);
    expect(html).toContain("¥2,000.00"); expect(html).toContain("¥2,500.00");
    expect(html).toContain("当前在售价格"); expect(html).toContain("最新编辑版本");
    expect(html).not.toContain("删除 / 停售");
  });
  it("keeps the desktop off-sale action on one line with a stable accessible name", () => {
    const html = renderToStaticMarkup(<PlatformCatalogManagementPanel model={model([version("sold-v1", 1)], ["commercial.catalog.publish"])} />);
    expect(html).toContain('aria-label="下架"');
    expect(html).toContain('aria-label="归档"');
    expect(html).toContain("white-space:nowrap");
  });
  it("fails closed on catalog actions until the server cursor proves the result set is complete", () => {
    const html = renderToStaticMarkup(<PlatformCatalogManagementPanel model={model([version("pending-v2", 2, { approvalState: "pending_business_approval", currentSaleState: "unlisted", currentSaleVersionId: null })], ["commercial.catalog.approve"])} />);
    const before = html.slice(0, html.indexOf("审批通过</span>"));
    expect(before.slice(before.lastIndexOf("<button"))).toContain("disabled");
    expect(html).toContain("审批通过");
    expect(html).toContain("加载更多商品版本");
  });
  it("marks stale data and disables writes when the latest read failed", () => {
    const html = renderToStaticMarkup(<PlatformCatalogManagementPanel model={model([version("sold-v1", 1)], ["commercial.catalog.draft", "commercial.catalog.publish"], "仓储不可用")} />);
    expect(html).toContain("目录读取失败，旧数据可能已过期"); expect(html).toContain("数量暂不可确认");
    const before = html.slice(0, html.indexOf("新增套餐草稿</span>"));
    expect(before.slice(before.lastIndexOf("<button"))).toContain("disabled");
  });
});

describe("catalog mutation refresh lifecycle", () => {
  it("starts the direct catalog refresh without waiting for an unrelated model refresh", async () => {
    let finishModelRefresh!: () => void;
    const modelRefresh = new Promise<void>(resolve => { finishModelRefresh = resolve; });
    let modelRefreshFinished = false;
    void modelRefresh.then(() => { modelRefreshFinished = true; });
    const steps: string[] = [];

    await mutateCatalogAndStartRefresh(async () => { steps.push("mutation committed"); }, () => {
      steps.push("direct catalog refresh started");
      void modelRefresh;
    });

    expect(steps).toEqual(["mutation committed", "direct catalog refresh started"]);
    expect(modelRefreshFinished).toBe(false);
    finishModelRefresh();
  });
});

describe("registered benefit submission", () => {
  it("refuses to treat GB quantities as normalized storage bytes", () => {
    expect(() => encodeBenefits([{ code: "cloud_storage", value: 50, unit: "GB", policyRef: "approved:storage" }])).toThrow("字节");
    expect(encodeBenefits([{ code: "cloud_storage", value: 50000000000, unit: "byte", policyRef: "approved:storage" }])[0]?.normalizedValue).toBe(50000000000);
  });
  it("enforces boolean feature grants and retains source expiry metadata", () => {
    expect(() => encodeBenefits([{ code: "feature.example", value: 2, unit: "boolean" }])).toThrow("0或授权1");
    const values = encodeBenefits([{ code: "creative_points", value: 500, unit: "point", policyRef: "approved:points" }], [{ code: "creative_points", metadata: { expiryPolicy: "30days" } }]);
    expect(values[0]?.metadata).toEqual({ expiryPolicy: "30days" });
  });
});

describe("versioned onboarding and recovery policy", () => {
  it("persists the registered 30-day creative point-pack expiry consumer in its version", () => {
    expect(catalogPolicyPatch({}, { kind: "point_pack", validityDays: 30 })).toMatchObject({ expiryRule: "purchase_plus_30_natural_days", expiryDays: 30 });
    expect(catalogPolicyPatch({}, { kind: "point_pack", validityDays: 15 })).toMatchObject({ expiryRule: null, expiryDays: 15 });
  });
  it("keeps a non-default gift schedule when changing price and records the real policy object", () => {
    const patch = catalogPolicyPatch({ grantSchedule: { auditNote: "retained" } }, { kind: "onboarding", giftCount: 9, giftPoints: 777, onboardingPolicyVersion: "v2", recoveryEnabled: true, recoveryVersion: "refund-v1", recoveryEffect: "cancel_contract" });
    expect(patch.grantSchedule).toMatchObject({ grantCount: 9, pointsPerGrant: 777, timezone: "UTC", auditNote: "retained", policyRef: { policyId: "commercial.onboarding", version: "v2", permission: "commercial.onboarding.purchase" } });
    expect(patch.policyRef).toEqual(patch.grantSchedule?.policyRef);
    expect(patch.sourceRecoveryPolicy).toMatchObject({ approved: true, version: "refund-v1", effect: "cancel_contract" });
  });
  it("rejects invalid gift bounds and incomplete or inappropriate recovery policies", () => {
    expect(() => catalogPolicyPatch({}, { kind: "onboarding", giftCount: 25, giftPoints: 500 })).toThrow("1至24");
    expect(() => catalogPolicyPatch({}, { kind: "onboarding", giftCount: 6, giftPoints: 0 })).toThrow("正整数");
    expect(() => catalogPolicyPatch({}, { kind: "monthly", recoveryEnabled: true, recoveryVersion: "refund-v1", recoveryEffect: "unused_points_only" })).toThrow("只适用于");
    expect(() => catalogPolicyPatch({}, { kind: "monthly", recoveryEnabled: true, recoveryEffect: "cancel_contract" })).toThrow("政策版本");
  });
});

describe("complete benefit-bundle option loading", () => {
  const bundle = (versionId: string) => ({ id: versionId, code: "benefit-core", versionId, version: 1, name: versionId, usage: "included" as const, lifecycle: "approved", benefits: [], payload: {}, checksum: versionId, revision: 1, state: "active" });

  it("follows every server cursor before exposing bundle options", async () => {
    const loadPage = vi.fn()
      .mockResolvedValueOnce({ items: [bundle("bundle-v1")], total: 2, nextCursor: "cursor-2", truncated: false })
      .mockResolvedValueOnce({ items: [bundle("bundle-v2")], total: 2, nextCursor: null, truncated: false });

    await expect(loadAllBenefitBundlePages(loadPage)).resolves.toEqual([bundle("bundle-v1"), bundle("bundle-v2")]);
    expect(loadPage).toHaveBeenNthCalledWith(1, { limit: 100 }, undefined);
    expect(loadPage).toHaveBeenNthCalledWith(2, { limit: 100, cursor: "cursor-2" }, undefined);
  });

  it("fails closed when the server repeats a cursor", async () => {
    const loadPage = vi.fn().mockResolvedValue({ items: [], total: 1, nextCursor: "same-cursor", truncated: false });
    await expect(loadAllBenefitBundlePages(loadPage)).rejects.toThrow("游标重复");
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("keeps earlier version options when the bundle manager refreshes only its current page", () => {
    const first = bundle("bundle-v1");
    const second = { ...bundle("bundle-v2"), version: 2 };
    expect(mergeBenefitBundleVersions([first], [second])).toEqual([first, second]);
  });
});
