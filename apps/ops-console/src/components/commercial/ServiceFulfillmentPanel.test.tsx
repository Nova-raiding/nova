import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => {
  const passthrough = ({ children, ...props }: any) => createElement("div", props, children);
  const Input = ({ placeholder, children }: any) => createElement("input", { placeholder }, children);
  Input.Password = ({ placeholder }: any) => createElement("input", { type: "password", placeholder });
  return {
    Alert: ({ title, description }: any) => createElement("div", { role: "alert" }, title, description),
    Button: ({ children, disabled }: any) => createElement("button", { disabled }, children),
    Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
    Input,
    InputNumber: ({ placeholder }: any) => createElement("input", { placeholder }),
    Select: ({ options = [] }: any) => createElement("select", null, options.map((option: any) => createElement("option", { key: option.value }, option.label))),
    Space: ({ children }: any) => createElement("div", null, children),
    Typography: { Text: ({ children }: any) => createElement("span", null, children) },
  };
});

import { ServiceFulfillmentPanel } from "./ServiceFulfillmentPanel.js";

const controller = (overrides: any = {}): any => ({
  permissions: { canWriteService: false, ...overrides.permissions },
  targetWorkspaceId: overrides.targetWorkspaceId,
  client: { createServiceAllocation: vi.fn(), scheduleService: vi.fn(), startService: vi.fn(), completeService: vi.fn(), adjustService: vi.fn() },
});

describe("ServiceFulfillmentPanel", () => {
  it("keeps fulfillment read-only without write permission or workspace scope", () => {
    const html = renderToStaticMarkup(<ServiceFulfillmentPanel controller={controller()} />);
    expect(html).toContain("当前账号无履约写权限");
    expect(html).toContain("缺少目标 Workspace");
    expect(html).toContain("审批人令牌（由审批人本人提供）");
    expect(html).toContain("提交命令");
  });

  it("exposes the revision, idempotency, reason, and approval evidence controls when enabled", () => {
    const html = renderToStaticMarkup(<ServiceFulfillmentPanel controller={controller({ targetWorkspaceId: "workspace-1", permissions: { canWriteService: true } })} />);
    expect(html).toContain("服务履约操作");
    expect(html).toContain("allocation_id");
    expect(html).toContain("revision");
    expect(html).toContain("审计原因（至少 3 字符）");
    expect(html).toContain("提交成功后自动清空");
    expect(html).not.toContain("当前账号无履约写权限");
    expect(html).not.toContain("缺少目标 Workspace");
  });
});
