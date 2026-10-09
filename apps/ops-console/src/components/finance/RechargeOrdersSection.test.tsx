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
      { id: "recharge_1002", workspace_id: "workspace_demo", channel: "alipay", amount_cny: "50.00", state: "paid", payment_url: null, provider_trade_id: "trade_1002", expires_at: null, paid_at: "2026-08-27T07:30:00.000Z", created_at: "2026-08-27T07:00:00.000Z" },
      { id: "recharge_1003", workspace_id: "workspace_demo", channel: "wechat", amount_cny: "25.00", state: "paid", payment_url: null, provider_trade_id: "trade_1003", expires_at: null, paid_at: "2026-08-26T07:30:00.000Z", created_at: "2026-08-26T07:00:00.000Z" },
      { id: "recharge_1004", workspace_id: "workspace_demo", channel: "alipay", amount_cny: "10.00", state: "failed", payment_url: null, provider_trade_id: null, expires_at: null, paid_at: null, created_at: "2026-08-25T07:00:00.000Z" },
    ],
    returned: 4,
    total: 4,
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

  it("disables every payment lookup while any order lookup is in flight", () => {
    const html = renderToStaticMarkup(
      <RechargeOrdersSection
        model={{ ...model, queryingRechargeOrderId: "recharge_1001" } as OpsConsoleModel}
      />,
    );
    const lookupButton = html.match(/<button[^>]*aria-label="查询充值订单 recharge_1001"[^>]*>/)?.[0] ?? "";
    expect(lookupButton).toContain("disabled");
  });

  it("renders a failed or unrun read as unread instead of as measured zeros", () => {
    // `rechargeOrders === undefined` is the model's "not read" state — what
    // `loadRechargeOrders` resets to on failure. Coalescing it to `[]` produced
    // the identical summary row as a server that legitimately answered with no
    // orders: `订单总数 0 / 待支付 0 / 已支付 0 / 异常 0`, where "异常 0" reads
    // as the all-clear directly above the alert saying the read failed.
    const html = renderToStaticMarkup(
      <RechargeOrdersSection
        model={{ ...model, rechargeOrders: undefined, rechargeOrdersError: "支付渠道暂不可用" } as OpsConsoleModel}
      />,
    );

    expect(html).not.toContain("全部 0");
    expect(html).not.toContain("异常 0");
    expect(html).toContain("—");
    expect(html).toContain("尚未读取充值订单");
    expect(html).not.toContain("当前筛选条件下没有充值订单");
  });

  it("warns when the server total exceeds the returned order rows", () => {
    const html = renderToStaticMarkup(
      <RechargeOrdersSection
        model={{ ...model, rechargeOrders: { ...model.rechargeOrders, returned: 100, total: 125 } } as OpsConsoleModel}
      />,
    );

    expect(html).toContain("充值订单分页信息不完整");
    expect(html).toContain("服务端共 125 条，当前仅返回 100 条");
    expect(html).toContain("服务端没有提供下一页游标");
  });

  it("offers server pagination when the response includes a cursor", () => {
    const html = renderToStaticMarkup(
      <RechargeOrdersSection
        model={{ ...model, rechargeOrders: { ...model.rechargeOrders, returned: 100, total: 125, next_cursor: "cursor-next" } } as OpsConsoleModel}
      />,
    );

    expect(html).toContain('aria-label="加载更多充值订单"');
    expect(html).not.toContain("充值订单分页信息不完整");
  });

  it("still reports a successful read that legitimately returned nothing as zero", () => {
    // The other half of the same distinction: an honest zero must stay a zero,
    // otherwise the fix would have traded one lie for another.
    const html = renderToStaticMarkup(
      <RechargeOrdersSection
        model={{
          ...model,
          rechargeOrders: { orders: [], summary: { total: 0, by_state: { pending: 0, paid: 0, closed: 0, failed: 0 } } },
        } as OpsConsoleModel}
      />,
    );

    expect(html).toContain("全部 0");
    expect(html).toContain("异常 0");
    expect(html).toContain("当前筛选条件下没有充值订单");
    expect(html).not.toContain("尚未读取充值订单");
  });
});
