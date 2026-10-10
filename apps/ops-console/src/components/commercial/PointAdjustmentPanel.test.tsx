import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => {
  const passthrough = ({ children, ...props }: any) => createElement("div", props, children);
  const Button = ({ children, disabled, "aria-label": ariaLabel }: any) => createElement("button", { disabled, "aria-label": ariaLabel }, children);
  const Input = ({ value, placeholder, onChange, "aria-label": ariaLabel }: any) => createElement("input", { value, placeholder, onChange, "aria-label": ariaLabel });
  Input.TextArea = ({ value, placeholder, onChange, "aria-label": ariaLabel }: any) => createElement("textarea", { value, placeholder, onChange, "aria-label": ariaLabel });
  const Typography = { Text: ({ children }: any) => createElement("span", null, children) };
  return {
    Alert: ({ title, description }: any) => createElement("div", { role: "alert" }, title, description),
    Button,
    Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
    Input,
    InputNumber: ({ placeholder }: any) => createElement("input", { placeholder }),
    Modal: ({ title, children }: any) => createElement("div", null, title, children),
    Space: Object.assign(passthrough, { Compact: passthrough }),
    Typography,
  };
});

import { PointAdjustmentPanel } from "./PointAdjustmentPanel.js";

const controller = (overrides: any = {}): any => ({
  permissions: { canAdjustPoints: false, canApprovePoints: false, ...overrides.permissions },
  targetWorkspaceId: overrides.targetWorkspaceId,
  client: {
    proposePointAdjustment: vi.fn(),
    decidePointAdjustment: vi.fn(),
  },
});

describe("PointAdjustmentPanel", () => {
  it("fails closed when adjustment permission or workspace scope is missing", () => {
    const html = renderToStaticMarkup(<PointAdjustmentPanel controller={controller()} />);
    expect(html).toContain("当前账号无点数调整权限");
    expect(html).toContain("缺少目标 Workspace");
    expect(html).toContain("新建调整提议");
    expect(html).toContain("disabled");
  });

  it("shows proposal creation and independent approval controls only for scoped capabilities", () => {
    const html = renderToStaticMarkup(<PointAdjustmentPanel controller={controller({ targetWorkspaceId: "workspace-1", permissions: { canAdjustPoints: true, canApprovePoints: true } })} />);
    expect(html).toContain("点数调整（双人审批）");
    expect(html).toContain("创建点数调整提议");
    expect(html).toContain("输入待审批 proposal_id");
    expect(html).toContain('aria-label="批准点数调整提议"');
    expect(html).toContain('aria-label="驳回点数调整提议"');
    expect(html).toContain("批准");
    expect(html).toContain("驳回");
    expect(html).toContain("审批必须由另一具备审批 capability 的账号完成");
    expect(html).not.toContain("当前账号无点数调整权限");
    expect(html).not.toContain("缺少目标 Workspace");
  });
});
