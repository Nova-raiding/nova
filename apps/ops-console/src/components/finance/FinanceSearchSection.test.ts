import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FinanceSearchController } from "../../hooks/useFinanceSearch.js";
import { FinanceSearchSection, financeStatusTagColor, parseFinanceWorkspaceIdFilter } from "./FinanceSearchSection.js";
import { financeDetailAttributeLabel, financeDetailAttributeValue, financeRecordCostEvidence } from "./FinanceDetailDrawer.js";

function controller(overrides: Partial<FinanceSearchController> = {}): FinanceSearchController {
  return {
    query: { limit: 50 }, records: [], resultsStale: false, loading: false, loadingMore: false, detailLoading: false, exporting: false,
    search: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined), openDetail: vi.fn(async () => undefined), retryDetail: vi.fn(async () => undefined), closeDetail: vi.fn(), downloadCsv: vi.fn(async () => undefined),
    ...overrides,
  };
}

const render = (value: FinanceSearchController) => renderToStaticMarkup(createElement(FinanceSearchSection, { controller: value }));

describe("FinanceSearchSection", () => {
  it("keeps failed status tone consistent with case-insensitive status labels", () => {
    expect(financeStatusTagColor("failed")).toBe("red");
    expect(financeStatusTagColor("FAILED")).toBe("red");
    expect(financeStatusTagColor("Manual_Attention")).toBe("red");
    expect(financeStatusTagColor("paid")).toBe("blue");
  });

  it("labels the workspace filter as IDs and parses only ID tokens", () => {
    const html = render(controller());
    expect(html).toContain('placeholder="输入一个或多个 Workspace ID，使用空格或逗号分隔"');
    expect(html).not.toContain("企业名称或 Workspace ID");
    expect(parseFinanceWorkspaceIdFilter(" ws_one, ws_two\nws_three，ws_four ")).toEqual([
      "ws_one", "ws_two", "ws_three", "ws_four",
    ]);
    expect(parseFinanceWorkspaceIdFilter(undefined)).toBeUndefined();
  });

  it("explains the paid cash subscription without hiding audit values", () => {
    expect(financeDetailAttributeLabel("sku_code")).toBe("套餐代码");
    expect(financeDetailAttributeLabel("sku_version_id")).toBe("套餐版本");
    expect(financeDetailAttributeLabel("payment_provider")).toBe("支付方式");
    expect(financeDetailAttributeLabel("created_by_actor_id")).toBe("登记操作人");
    expect(financeDetailAttributeValue("payment_provider", "owner_attested_cash")).toBe("现金收款（负责人核验） · owner_attested_cash");
    expect(financeDetailAttributeValue("payment_provider", "alipay")).toBe("支付宝 · alipay");
    expect(financeDetailAttributeValue("sku_code", "growth")).toBe("growth");
    expect(financeRecordCostEvidence("subscription_order", undefined)).toBe("不适用");
    expect(financeRecordCostEvidence("recharge_order", undefined)).toBe("不适用");
    expect(financeRecordCostEvidence("model_usage", undefined)).toBe("待核验");
    expect(financeRecordCostEvidence("model_usage", 0.003511)).toBe("¥0.003511");
  });
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
          subscriptionOrderWorkspaceCount: 0,
          subscriptionOrderBySku: {},
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

  it("shows a load-more trigger when finance search has a next cursor", () => {
    const html = render(controller({
      page: {
        records: [],
        summary: {
          totalRecords: 40,
          rechargeOrderCny: 0,
          subscriptionOrderCny: 0,
          subscriptionOrderWorkspaceCount: 0,
          subscriptionOrderBySku: {},
          walletNetCny: 0,
          walletCreditCny: 0,
          walletDebitCny: 0,
          usageUnits: 0,
          providerCostCny: 0,
          customerChargeCny: 0,
          byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 },
        },
        nextCursor: "finance-next",
        snapshotAt: "2026-08-29T00:00:00.000Z",
        scope: { role: "platform_ops", workspaceCount: 1 },
      },
    }));
    expect(html).toContain("加载更多财务记录");
  });

  it("does not render load-more when search is fully paged", () => {
    const html = render(controller({ page: {
      records: [],
      summary: {
        totalRecords: 20,
        rechargeOrderCny: 0,
        subscriptionOrderCny: 0,
        subscriptionOrderWorkspaceCount: 0,
        subscriptionOrderBySku: {},
        walletNetCny: 0,
        walletCreditCny: 0,
        walletDebitCny: 0,
        usageUnits: 0,
        providerCostCny: 0,
        customerChargeCny: 0,
        byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 },
      },
      snapshotAt: "2026-08-29T00:00:00.000Z",
      scope: { role: "platform_ops", workspaceCount: 1 },
    } }));
    expect(html).not.toContain("加载更多财务记录");
  });

  it("does not present a local cost snapshot as Provider-reconciled", () => {
    const html = render(controller({ page: {
      records: [],
      summary: { totalRecords: 0, rechargeOrderCny: 0, subscriptionOrderCny: 0, subscriptionOrderWorkspaceCount: 0, subscriptionOrderBySku: {}, walletNetCny: 0, walletCreditCny: 0, walletDebitCny: 0, usageUnits: 0, providerCostCny: 1.25, customerChargeCny: 0, providerCostStatus: "verified", providerStatementStatus: "not_checked", byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } },
      snapshotAt: "2026-08-29T00:00:00.000Z", scope: { role: "platform_ops", workspaceCount: 1 },
    } }));
    expect(html).toContain("本地成本快照");
    expect(html).toContain("本次检索未执行 Provider 对账");
    expect(html).toContain("不代表全局已与 Provider 平账");
  });

  it("does not show workspace-only Provider reconciliation status in the platform view", () => {
    const html = renderToStaticMarkup(createElement(FinanceSearchSection, {
      controller: controller({ page: {
        records: [],
        summary: { totalRecords: 0, rechargeOrderCny: 0, subscriptionOrderCny: 0, subscriptionOrderWorkspaceCount: 0, subscriptionOrderBySku: {}, walletNetCny: 0, walletCreditCny: 0, walletDebitCny: 0, usageUnits: 0, providerCostCny: 1.25, customerChargeCny: 0, providerCostStatus: "verified", providerStatementStatus: "not_checked", byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } },
        snapshotAt: "2026-08-29T00:00:00.000Z", scope: { role: "platform_ops", workspaceCount: 1 },
      } }),
      showProviderStatementStatus: false,
    }));
    expect(html).not.toContain("本次检索未执行 Provider 对账");
    expect(html).not.toContain("不代表全局已与 Provider 平账");
  });

  it("announces loading without replacing existing records", () => {
    const html = render(controller({ loading: true }));
    expect(html).toContain("正在加载财务记录");
  });

  it("retries the last submitted filters and reflects successful query state in the form", () => {
    const source = readFileSync(new URL("./FinanceSearchSection.tsx", import.meta.url), "utf8");
    expect(source).toContain("submittedQueryRef.current = submittedQuery");
    expect(source).toContain("controller.search(submittedQueryRef.current ?? {})");
    expect(source).toContain("form.setFieldsValue({");
    expect(source).toContain('workspaceIds: controller.query.workspaceIds?.join(", ")');
    expect(source).toContain("onClick={retrySearch}");
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
