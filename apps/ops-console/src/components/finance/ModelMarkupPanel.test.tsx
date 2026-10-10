import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => {
  const passthrough = ({ children }: any) => createElement("div", null, children);
  const Input = ({ placeholder, disabled, "aria-label": ariaLabel }: any) => createElement("input", { placeholder, disabled, "aria-label": ariaLabel });
  const Typography = {
    Text: ({ children }: any) => createElement("span", null, children),
    Paragraph: ({ children }: any) => createElement("p", null, children),
  };
  return {
    Alert: ({ title, description, action }: any) => createElement("div", { role: "alert" }, title, description, action),
    Button: ({ children, disabled }: any) => createElement("button", { disabled }, children),
    Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
    Input,
    InputNumber: ({ disabled }: any) => createElement("input", { disabled }),
    Space: passthrough,
    Tag: ({ children }: any) => createElement("span", null, children),
    Typography,
  };
});

import { ModelMarkupPanel } from "./ModelMarkupPanel.js";

const model = (overrides: any = {}): any => ({
  modelMarkup: undefined,
  modelMarkupLoading: false,
  modelMarkupError: undefined,
  modelMarkupReason: "",
  canModelMarkup: false,
  canModelMarkupUpdate: false,
  setModelMarkup: vi.fn(),
  setModelMarkupReason: vi.fn(),
  saveModelMarkup: vi.fn(),
  loadModelMarkup: vi.fn(),
  ...overrides,
});

describe("ModelMarkupPanel", () => {
  it("fails closed when the global markup policy has not been read", () => {
    const html = renderToStaticMarkup(<ModelMarkupPanel model={model()} />);
    expect(html).toContain("尚未读取到全局倍率配置");
    expect(html).toContain("当前不能编辑");
    expect(html).toContain("重试");
    expect(html).toContain("Revision -");
    expect(html).toContain('disabled=""');
  });

  it("shows the API error and retry affordance without claiming a usable policy", () => {
    const html = renderToStaticMarkup(<ModelMarkupPanel model={model({ modelMarkupError: "倍率服务不可用" })} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("计费倍率读取失败");
    expect(html).toContain("倍率服务不可用");
    expect(html).toContain("重试");
    expect(html).not.toContain("尚未读取到全局倍率配置");
  });

  it("keeps a loaded policy read-only without commercial.update", () => {
    const html = renderToStaticMarkup(<ModelMarkupPanel model={model({ modelMarkup: { multiplier: 2.5, revision: 4 }, modelMarkupReason: "", canModelMarkup: true })} />);
    expect(html).toContain("Revision 4");
    expect(html).toContain("当前账号只有读取权限");
    expect(html).toContain("修改倍率需要 `commercial.update`");
    expect(html).toContain("保存并生效");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Token 计费倍率变更原因"/u);
  });

  it("enables the change reason only when a loaded policy can be updated", () => {
    const html = renderToStaticMarkup(<ModelMarkupPanel model={model({ modelMarkup: { multiplier: 2.5, revision: 4 }, canModelMarkup: true, canModelMarkupUpdate: true })} />);
    expect(html).toMatch(/aria-label="Token 计费倍率变更原因"/u);
    expect(html).not.toMatch(/aria-label="Token 计费倍率变更原因" disabled=""/u);
  });
});
