import type {
  RechargeOrder,
  RechargeOrderState,
  RechargeOrderSummary,
} from "../../types/ops.js";

export type PaymentReconciliationReport = {
  state?: string;
  skipped_fixture_orders?: number;
  settled?: readonly unknown[];
  pending?: readonly unknown[];
  failed?: readonly unknown[];
};

export const rechargeOrderStates = [
  "pending",
  "paid",
  "closed",
  "failed",
] as const satisfies readonly RechargeOrderState[];

export const rechargeOrderPresentation: Record<
  RechargeOrderState,
  { label: string; color: string }
> = {
  pending: { label: "待支付", color: "gold" },
  paid: { label: "已支付", color: "green" },
  closed: { label: "已关闭", color: "default" },
  failed: { label: "异常", color: "red" },
};

export function rechargeOrderCount(
  state: RechargeOrderState,
  summary: RechargeOrderSummary | undefined,
  orders: RechargeOrder[],
) {
  return summary?.by_state?.[state] ?? summary?.[state] ??
    orders.filter((order) => order.state === state).length;
}

export function rechargeOrderTotal(
  summary: RechargeOrderSummary | undefined,
  orders: RechargeOrder[],
  total?: number,
) {
  return total ?? summary?.total ?? orders.length;
}

export function rechargeOrderListParams(state?: RechargeOrderState) {
  return { limit: "100", ...(state ? { states: state } : {}) };
}

export function safePaymentUrl(value: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function paymentReconciliationOutcome(report: PaymentReconciliationReport) {
  const settled = report.settled?.length ?? 0;
  const pending = report.pending?.length ?? 0;
  const failed = report.failed?.length ?? 0;
  if (report.state === "not_configured") return { level: "warning" as const, message: "支付 provider 查单未配置：未查询任何订单，也未发生入账" };
  if (report.state === "completed" && (report.skipped_fixture_orders ?? 0) > 0 && settled === 0 && pending === 0 && failed === 0) return { level: "info" as const, message: `没有可查的 Provider 订单：跳过 ${report.skipped_fixture_orders} 条 fixture 订单，未发生入账` };
  if (report.state === "attention_required" || pending > 0 || failed > 0) return { level: "warning" as const, message: `支付对账未收口：入账 ${settled}，仍待确认 ${pending}，异常 ${failed}` };
  if (report.state === "completed") return { level: "success" as const, message: `支付对账完成：入账 ${settled}` };
  return { level: "error" as const, message: "支付对账返回未识别状态：未确认任何入账，请先核对服务端对账证据" };
}

export function paymentQueryOutcome(response: {
  state?: string;
  payment_mode?: string;
  providerStatus?: { state?: string };
}) {
  const providerState = response.providerStatus?.state;
  if (response.payment_mode === "fixture") return { level: "info" as const, message: "订单为 fixture：仅本地测试状态，不代表真实支付到账" };
  if (providerState === "pending" || response.state === "pending") return { level: "warning" as const, message: "订单仍待支付或待 provider 确认；本次没有入账" };
  if (providerState === "failed" || providerState === "closed" || response.state === "failed" || response.state === "closed") return { level: "warning" as const, message: `订单未入账，provider 状态：${providerState ?? response.state}` };
  if (providerState === "paid" || response.state === "paid") return { level: "success" as const, message: "订单已由服务端确认到账" };
  return { level: "error" as const, message: "订单查单返回未识别状态：未确认到账，请先核对服务端支付证据" };
}
