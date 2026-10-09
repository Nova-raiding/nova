import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { RefundSection } from "./RefundSection.js";

function renderWorkspace() {
  const model = {
    authorization: { scope: { kind: "workspace" } },
    refundForm: { scrollToField: vi.fn() },
    refund: vi.fn(),
    canFinance: true,
    refundSubmitting: false,
  } as unknown as OpsConsoleModel;
  return renderToStaticMarkup(<RefundSection model={model} />);
}

describe("RefundSection API authorization boundary", () => {
  it("does not offer a workspace finance form that billing.refund will reject", () => {
    const html = renderWorkspace();

    expect(html).toContain("当前工作区暂不开放充值订单退款");
    expect(html).toContain("仅接受平台运营财务身份");
    expect(html).not.toContain("创建退款");
    expect(html).not.toContain('aria-label="创建退款"');
  });

});
