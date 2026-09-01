import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { ReconciliationSection } from "./ReconciliationSection.js";

const model = {
  reconciliation: undefined,
  loading: false,
  dataSetError: vi.fn(() => undefined),
  load: vi.fn(),
  canPaymentReconciliation: false,
  canModelSettlement: false,
  canBillingExport: false,
  runReconciliation: vi.fn(),
  runModelUsageReconciliation: vi.fn(),
  retryModelUsageSettlement: vi.fn(),
  waiveModelUsageSettlement: vi.fn(),
  markModelUsageForManualAttention: vi.fn(),
  exportBilling: vi.fn(),
} as unknown as OpsConsoleModel;

const renderSection = (overrides: Partial<OpsConsoleModel> = {}) =>
  renderToStaticMarkup(
    createElement(ReconciliationSection, {
      model: { ...model, ...overrides } as OpsConsoleModel,
    }),
  );

const reconciliationFixture = {
  balance_cny: "0.00",
  recharge_cny: "0.00",
  debit_cny: "0.00",
  refund_cny: "0.00",
  transaction_count: 0,
  transactions: [],
  model_usage: {
    record_count: 1,
    total_tokens: 10,
    provider_cost_cny: null,
    customer_charge_cny: "0.00",
    unsettled_records: 0,
    by_modality: {},
    unsettled: [],
    reconciliation_status: "provider_state_drift",
    external_provider_statement: { status: "externally_unverified", note: "尚未核验" },
  },
  provider: { mode: "relay", ready: true, reasons: [] },
};

describe("ReconciliationSection finance actions", () => {
  it("distinguishes an empty reconciliation response from a failed read", () => {
    expect(renderSection()).toContain("当前没有可展示的对账数据");
    expect(renderSection({ dataSetError: () => "账务服务不可用" })).toContain("错误状态不代表账务为空");
  });

  it("shows an accessible loading state before reconciliation data arrives", () => {
    const html = renderSection({ loading: true });

    expect(html).toContain("正在加载账务与模型用量对账");
    expect(html).not.toContain("当前没有可展示的对账数据");
  });

  it("hides billing export from roles without export permission", () => {
    expect(renderSection()).not.toContain("导出账单");
  });

  it("shows billing export to authorized finance roles", () => {
    expect(renderSection({ canBillingExport: true })).toContain("导出账单");
  });

  it("keeps model reconciliation enabled for platform_ops permissions", () => {
    const html = renderSection({ canModelSettlement: true });

    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>[^<]*<span>重试模型结算<\/span><\/button>/);
  });

  it("renders unknown reconciliation states as blocked errors, never success", () => {
    const html = renderSection({ reconciliation: reconciliationFixture as never });

    expect(html).toContain("未知状态（已阻断）");
    expect(html).toMatch(/ant-alert-error[^>]*>[\s\S]*模型用量对账状态：未知状态（已阻断）/);
    expect(html).toMatch(/ant-alert-error[^>]*>[\s\S]*模型用量：未知状态（已阻断）/);
  });

  it("announces a stale-data refresh while retaining the existing snapshot", () => {
    const html = renderSection({ loading: true, reconciliation: reconciliationFixture as never });

    expect(html).toContain("正在刷新对账数据");
    expect(html).toContain("页面暂时保留上次成功数据");
    expect(html).toContain('aria-busy="true"');
  });

  it("exposes disabled-action reasons to assistive technology", () => {
    const html = renderSection();

    expect(html).toContain('aria-describedby="reconciliation-payment-disabled-reason"');
    expect(html).toContain("当前账号没有支付查单权限");
    expect(html).toContain('aria-describedby="reconciliation-model-disabled-reason"');
    expect(html).toContain("当前账号没有模型结算权限");
  });

  it("distinguishes task run keys from call action ids in unsettled usage", () => {
    const reconciliation = {
      ...reconciliationFixture,
      model_usage: {
        ...reconciliationFixture.model_usage,
        unsettled_records: 2,
        unsettled: [
          {
            id: "usage-linked",
            run_key: "task-run-42",
            action_id: "provider-call-7",
            modality: "text",
            model: "relay-text",
            provider_request_id: "provider-1",
            observed_at: "2026-08-31T08:00:00.000Z",
            settlement_status: "pending_wallet",
            settlement_reason: "wallet settlement failed",
            last_error: { code: "MODEL_WALLET_SETTLEMENT_FAILED" },
          },
          {
            id: "usage-unlinked",
            run_key: null,
            action_id: "provider-call-8",
            modality: "image",
            model: "relay-image",
            provider_request_id: null,
            observed_at: "2026-08-31T08:01:00.000Z",
            settlement_status: "manual_attention",
            settlement_reason: "budget linkage missing",
          },
        ],
      },
    };

    const html = renderSection({ reconciliation: reconciliation as never });

    expect(html).toContain('aria-label="模型用量待结算记录"');
    expect(html).toContain("任务 Run Key");
    expect(html).toContain("调用 Action ID");
    expect(html).toContain("task-run-42");
    expect(html).toContain("provider-call-7");
    expect(html).toContain("缺失（已阻断）");
    expect(html).toContain("错误码：");
    expect(html).toContain("MODEL_WALLET_SETTLEMENT_FAILED");
  });
});
