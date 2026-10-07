import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => ({
  Alert: ({ title, description, action }: any) => createElement("div", { role: "alert" }, title, description, action),
  Button: ({ children }: any) => createElement("button", null, children),
  Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
  Table: ({ dataSource, locale }: any) => createElement("div", null, dataSource?.length ? `${dataSource.length} rows` : locale.emptyText),
  Tag: ({ children }: any) => createElement("span", null, children),
}));

import { AutomationPolicySection } from "./AutomationPolicySection.js";

describe("AutomationPolicySection", () => {
  it("does not present a failed policy read as an empty policy set", () => {
    const html = renderToStaticMarkup(<AutomationPolicySection automationPolicies={[]} error="策略服务不可用" onRetry={vi.fn()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("自动化策略读取失败");
    expect(html).toContain("策略服务不可用");
    expect(html).toContain("重试");
    expect(html).not.toContain("暂无自动化策略");
  });

  it("labels an in-flight read as pending and avoids showing stale rows", () => {
    const html = renderToStaticMarkup(<AutomationPolicySection automationPolicies={[{ id: "policy-1", enabled: true, mode: "scan", frequencyMinutes: 15 } as any]} loading />);
    expect(html).toContain("状态待确认");
    expect(html).toContain("正在读取自动化策略");
    expect(html).not.toContain("1 条");
    expect(html).not.toContain("1 rows");
  });

  it("renders configured policy rows after a successful read", () => {
    const html = renderToStaticMarkup(<AutomationPolicySection automationPolicies={[{ id: "policy-1", enabled: true, mode: "scan", frequencyMinutes: 15 } as any]} />);
    expect(html).toContain("1 条");
    expect(html).toContain("1 rows");
  });
});
