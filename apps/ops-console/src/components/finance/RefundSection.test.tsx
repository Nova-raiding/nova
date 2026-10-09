import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "antd";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { RefundSection } from "./RefundSection.js";

function RefundSectionHarness({ scope, canFinance }: { scope: "workspace" | "platform"; canFinance: boolean }) {
  const [refundForm] = Form.useForm();
  const model = {
    authorization: { scope: { kind: scope } },
    refundForm,
    refund: vi.fn(),
    canFinance,
    refundSubmitting: false,
  } as unknown as OpsConsoleModel;
  return <RefundSection model={model} />;
}

function renderForScope(scope: "workspace" | "platform", canFinance = true) {
  return renderToStaticMarkup(<RefundSectionHarness scope={scope} canFinance={canFinance} />);
}

describe("RefundSection API authorization boundary", () => {
  it("does not offer a workspace finance form that billing.refund will reject", () => {
    const html = renderForScope("workspace");

    expect(html).toContain("当前工作区暂不开放充值订单退款");
    expect(html).toContain("仅接受平台管理员、运营管理员、平台运营或财务运营角色");
    expect(html).not.toContain("创建退款");
    expect(html).not.toContain('aria-label="创建退款"');
  });

  it("renders the recharge refund form for a platform identity with the projected refund grant", () => {
    const html = renderForScope("platform");

    expect(html).toContain('aria-label="创建退款"');
    expect(html).toContain("创建退款");
    expect(html).toContain("仅限平台管理员、运营管理员、平台运营或财务运营角色");
  });

  it("keeps the platform form disabled without the projected refund grant", () => {
    const html = renderForScope("platform", false);

    expect(html).toContain('aria-label="创建退款"');
    expect(html).toContain('disabled=""');
  });

});
