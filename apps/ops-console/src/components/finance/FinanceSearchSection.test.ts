import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FinanceSearchController } from "../../hooks/useFinanceSearch.js";
import { FinanceSearchSection } from "./FinanceSearchSection.js";

function controller(overrides: Partial<FinanceSearchController> = {}): FinanceSearchController {
  return {
    query: { limit: 50 }, records: [], loading: false, loadingMore: false, detailLoading: false, exporting: false,
    search: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined), openDetail: vi.fn(async () => undefined), retryDetail: vi.fn(async () => undefined), closeDetail: vi.fn(), downloadCsv: vi.fn(async () => undefined),
    ...overrides,
  };
}

const render = (value: FinanceSearchController) => renderToStaticMarkup(createElement(FinanceSearchSection, { controller: value }));

describe("FinanceSearchSection", () => {
  it("renders labeled filters and an accessible empty state", () => {
    const html = render(controller());
    expect(html).toContain("财务检索筛选");
    expect(html).toContain("当前筛选条件下没有财务记录");
    expect(html).toContain("已加载 0 条财务记录");
  });

  it("renders recoverable search and export errors", () => {
    const html = render(controller({ error: "搜索失败", exportError: "导出失败" }));
    expect(html).toContain("财务检索失败");
    expect(html).toContain("财务导出失败");
    expect(html).toContain('aria-label="重试财务检索"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-label="财务检索错误摘要"');
    expect(html).toContain("当前状态不能解释为零记录或零金额");
    expect(html).not.toContain("已加载 0 条财务记录");
    expect(html).not.toContain("当前筛选条件下没有财务记录");
  });

  it("keeps previously loaded records visible when a refresh fails", () => {
    const html = render(controller({
      error: "刷新失败",
      page: {
        records: [],
        summary: {
          totalRecords: 0,
          rechargeOrderCny: 0,
          subscriptionOrderCny: 0,
          walletNetCny: 0,
          walletCreditCny: 0,
          walletDebitCny: 0,
          usageUnits: 0,
          providerCostCny: 0,
          customerChargeCny: 0,
          byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 },
        },
        snapshotAt: "2026-08-29T00:00:00.000Z",
        scope: { role: "platform_ops", workspaceCount: 0 },
      },
    }));
    expect(html).toContain("已加载 0 条财务记录");
    expect(html).not.toContain("当前状态不能解释为零记录或零金额");
  });

  it("announces loading without replacing existing records", () => {
    const html = render(controller({ loading: true }));
    expect(html).toContain("正在加载财务记录");
  });

  it("offers an explicit retry when finance detail loading fails", () => {
    const source = readFileSync(new URL("./FinanceDetailDrawer.tsx", import.meta.url), "utf8");
    expect(source).toContain("详情加载失败");
    expect(source).toContain("onClick={onRetry}");
    expect(source).toContain("重试详情");
    expect(source).toContain('role="alert" aria-live="assertive" aria-atomic="true"');
    expect(source).toContain('aria-label="财务详情错误摘要"');
    expect(source).toContain('errorRef.current?.focus({ preventScroll: true })');
  });

  it("keeps detail loading announced and restores focus after closing", () => {
    const drawer = readFileSync(new URL("./FinanceDetailDrawer.tsx", import.meta.url), "utf8");
    const section = readFileSync(new URL("./FinanceSearchSection.tsx", import.meta.url), "utf8");
    expect(drawer).toContain('role="status" aria-live="polite" aria-label="正在加载财务详情"');
    expect(drawer).toContain('aria-busy={loading || undefined}');
    expect(drawer).toContain('htmlType="button"');
    expect(drawer).toContain('style={{ minHeight: 44 }}');
    expect(section).toContain('detailTriggerRef.current?.focus({ preventScroll: true })');
  });
});
