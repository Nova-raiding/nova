import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => {
  const Descriptions = ({ children }: any) => createElement("dl", null, children);
  Descriptions.Item = ({ label, children }: any) => createElement("div", null, createElement("dt", null, label), createElement("dd", null, children));
  const Typography = {
    Text: ({ children }: any) => createElement("span", null, children),
  };
  return {
    Alert: ({ title, description, action }: any) => createElement("div", { role: "alert" }, title, description, action),
    Button: ({ children }: any) => createElement("button", null, children),
    Descriptions,
    Drawer: ({ title, children }: any) => createElement("section", null, title, children),
    Empty: ({ description }: any) => createElement("div", null, description),
    Skeleton: () => createElement("div", null, "loading"),
    Space: ({ children }: any) => createElement("div", null, children),
    Tag: ({ children }: any) => createElement("span", null, children),
    Typography,
  };
});

import {
  FinanceDetailDrawer,
  financeDetailAttributeLabel,
  financeDetailAttributeValue,
  financeRecordCostEvidence,
} from "./FinanceDetailDrawer.js";

const selected = {
  id: "finance-1",
  kind: "model_usage",
  workspaceId: "workspace-1",
  status: "pending_cost",
  label: "模型用量",
  occurredAt: "2026-10-07T04:00:00.000Z",
  updatedAt: "2026-10-07T04:01:00.000Z",
  version: "v1",
  redacted: true,
} as any;

const detail = {
  ...selected,
  enterpriseName: "演示企业",
  providerCostCny: 0.000123,
  customerChargeCny: 0.12,
  attributes: {
    payment_mode: "fixture",
    refunded: false,
    order_id: null,
  },
} as any;

describe("FinanceDetailDrawer", () => {
  it("keeps cost evidence precise and excludes it for non-model records", () => {
    expect(financeRecordCostEvidence("model_usage", 0.000123)).toBe("¥0.000123");
    expect(financeRecordCostEvidence("model_usage", undefined)).toBe("待核验");
    expect(financeRecordCostEvidence("wallet_transaction", 12)).toBe("不适用");
  });

  it("renders safe, human-readable attributes and redacts null values", () => {
    expect(financeDetailAttributeLabel("payment_mode")).toBe("支付模式");
    expect(financeDetailAttributeLabel("unknown_field")).toBe("unknown_field");
    expect(financeDetailAttributeValue("payment_mode", "fixture")).toBe("演示记录 · fixture");
    expect(financeDetailAttributeValue("refunded", false)).toBe("否");
    expect(financeDetailAttributeValue("order_id", null)).toBe("—");
  });

  it("renders a loaded detail and a retryable accessible error state", () => {
    const html = renderToStaticMarkup(<FinanceDetailDrawer selected={selected} detail={detail} loading={false} onRetry={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("财务详情 · 模型用量");
    expect(html).toContain("¥0.000123");
    expect(html).toContain("演示记录 · fixture");
    expect(html).toContain("演示企业");

    const errorHtml = renderToStaticMarkup(<FinanceDetailDrawer selected={selected} loading={false} error="详情服务不可用" onRetry={vi.fn()} onClose={vi.fn()} />);
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("详情服务不可用");
    expect(errorHtml).toContain("重试详情");
  });
});
