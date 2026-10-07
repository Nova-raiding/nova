import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => ({
  Button: ({ children, disabled }: any) => createElement("button", { disabled }, children),
  Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
  Space: ({ children }: any) => createElement("div", null, children),
  Switch: ({ disabled, checked }: any) => createElement("input", { type: "checkbox", disabled, checked, readOnly: true }),
  Tag: ({ children }: any) => createElement("span", null, children),
  Typography: {
    Text: ({ children }: any) => createElement("span", null, children),
    Paragraph: ({ children }: any) => createElement("p", null, children),
  },
}));

import { AutoSyncSection } from "./AutoSyncSection.js";

const policy = { enabled: true, syncEnabled: false } as any;

describe("AutoSyncSection", () => {
  it("keeps sync controls disabled until a queue-capable operator selects a store", () => {
    const html = renderToStaticMarkup(<AutoSyncSection automationPolicy={policy} selectedAutomationStore={undefined} canQueue={true} onUpdateSync={vi.fn()} onUpdate={vi.fn(async () => undefined)} />);
    expect(html).toContain("自动商品同步");
    expect(html).toContain("未启用");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(html).toContain("请先在上方选择具体店铺");
  });

  it("enables the store-scoped controls only when policy and selection are present", () => {
    const html = renderToStaticMarkup(<AutoSyncSection automationPolicy={{ ...policy, syncEnabled: true }} selectedAutomationStore={{ label: "演示店铺" }} canQueue={true} onUpdateSync={vi.fn()} onUpdate={vi.fn(async () => undefined)} />);
    expect(html).toContain("已启用");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("只创建商品同步任务");
    expect(html).toContain("不会自动发布、自动重发或绕过人工确认");
  });
});
