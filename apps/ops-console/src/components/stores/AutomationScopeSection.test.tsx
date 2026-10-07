import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => ({
  Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
  Select: ({ disabled, options }: any) => createElement("select", { disabled }, options.map((option: any) => createElement("option", { key: option.value }, option.label))),
  Space: ({ children }: any) => createElement("div", null, children),
  Tag: ({ children }: any) => createElement("span", null, children),
  Typography: { Text: ({ children }: any) => createElement("span", null, children) },
}));

import { AutomationScopeSection } from "./AutomationScopeSection.js";

const stores = [{ label: "演示店铺", platform: "pdd", accountId: "acct-1" }] as any;

describe("AutomationScopeSection", () => {
  it("defaults to a workspace scope and disables selection without queue permission", () => {
    const html = renderToStaticMarkup(<AutomationScopeSection storeDirectory={stores} selectedAutomationStore={undefined} automationScope="" canQueue={false} onLoadScope={vi.fn(async () => undefined)} />);
    expect(html).toContain("全工作区");
    expect(html).toContain('disabled=""');
    expect(html).toContain("策略、扫描、暂停均按所选 platform + account_id 隔离");
  });

  it("shows the selected store and its platform-scoped option", () => {
    const html = renderToStaticMarkup(<AutomationScopeSection storeDirectory={stores} selectedAutomationStore={{ label: "演示店铺", platform: "pdd" }} automationScope="pdd:acct-1" canQueue={true} onLoadScope={vi.fn(async () => undefined)} />);
    expect(html).toContain("演示店铺（pdd）");
    expect(html).toContain("演示店铺 · pdd");
    expect(html).not.toContain('disabled=""');
  });
});
