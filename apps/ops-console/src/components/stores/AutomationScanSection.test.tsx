import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => {
  const passthrough = ({ children }: any) => createElement("div", null, children);
  return {
    Alert: ({ title, description, action }: any) => createElement("div", { role: "alert" }, title, description, action),
    Button: ({ children, disabled }: any) => createElement("button", { disabled }, children),
    Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
    Col: passthrough,
    Input: ({ placeholder }: any) => createElement("input", { placeholder }),
    InputNumber: ({ value, disabled }: any) => createElement("input", { type: "number", value, disabled }),
    Row: passthrough,
    Space: passthrough,
    Statistic: ({ title, value }: any) => createElement("div", null, title, value),
    Switch: ({ disabled }: any) => createElement("input", { type: "checkbox", disabled, readOnly: true }),
    Table: ({ dataSource, locale }: any) => createElement("div", null, dataSource?.length ? `${dataSource.length} rows` : locale.emptyText),
    Tag: ({ children }: any) => createElement("span", null, children),
    Typography: { Text: ({ children }: any) => createElement("span", null, children) },
  };
});

import { AutomationScanSection } from "./AutomationScanSection.js";

const baseProps: any = {
  automationPolicy: undefined,
  automationScan: undefined,
  canQueue: false,
  setAutomationPolicy: vi.fn(),
  onScan: vi.fn(async () => undefined),
  onUpdate: vi.fn(async () => undefined),
};

describe("AutomationScanSection", () => {
  it("fails closed on a read error and exposes retry without rendering scan data", () => {
    const html = renderToStaticMarkup(<AutomationScanSection {...baseProps} error="扫描状态不可用" onRetry={vi.fn()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("自动化状态读取失败");
    expect(html).toContain("扫描状态不可用");
    expect(html).toContain("重试");
  });

  it("distinguishes no scan result from a measured clean scan", () => {
    const unread = renderToStaticMarkup(<AutomationScanSection {...baseProps} />);
    expect(unread).toContain("状态待确认");
    expect(unread).toContain("尚未取得扫描结果");
    expect(unread).toContain("不代表已确认无风险");

    const clean = renderToStaticMarkup(<AutomationScanSection {...baseProps} automationScan={{ counts: { products: 3, publishJobs: 1, risks: 0 }, recommendations: [], risks: [] }} />);
    expect(clean).toContain("0 条");
    expect(clean).toContain("当前扫描没有优化建议");
    expect(clean).toContain("暂无扫描风险");
    expect(clean).not.toContain("尚未取得扫描结果");
  });
});
