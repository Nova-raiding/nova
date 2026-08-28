import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { RechargeOrdersSection } from "./RechargeOrdersSection.js";

const model = {
  rechargeOrders: {
    orders: [
      {
        id: "recharge_1001",
        workspace_id: "workspace_demo",
        channel: "alipay",
        amount_cny: "100.00",
        state: "pending",
        payment_url: "https://pay.example.com/recharge_1001",
        provider_trade_id: null,
        expires_at: "2026-08-28T08:00:00.000Z",
        paid_at: null,
        created_at: "2026-08-28T07:30:00.000Z",
      },
    ],
    summary: {
      total: 4,
      by_state: { pending: 1, paid: 2, closed: 0, failed: 1 },
    },
  },
  rechargeOrdersLoading: false,
  rechargeOrdersError: "",
  rechargeOrderStateFilter: undefined,
  canPaymentReconciliation: true,
  loadRechargeOrders: vi.fn(),
  queryRechargeOrder: vi.fn(),
  queryingRechargeOrderId: undefined,
} as unknown as OpsConsoleModel;

describe("RechargeOrdersSection", () => {
  it("renders status filters, refresh, lookup and a safe payment entry", () => {
    const html = renderToStaticMarkup(<RechargeOrdersSection model={model} />);

    expect(html).toContain("充值订单状态中心");
    expect(html).toContain("全部 4");
    expect(html).toContain("待支付 1");
    expect(html).toContain("已支付 2");
    expect(html).toContain("异常 1");
    expect(html).toContain("刷新");
    expect(html).toContain("查单");
    expect(html).toContain("支付页");
    expect(html).toContain("recharge_1001");
  });

  it("shows an actionable error without hiding the table", () => {
    const html = renderToStaticMarkup(
      <RechargeOrdersSection
        model={{ ...model, rechargeOrdersError: "支付渠道暂不可用" } as OpsConsoleModel}
      />,
    );

    expect(html).toContain("充值订单加载失败");
    expect(html).toContain("支付渠道暂不可用");
    expect(html).toContain('aria-label="重试加载充值订单"');
  });
});
