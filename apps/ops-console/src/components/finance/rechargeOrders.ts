import type {
  RechargeOrder,
  RechargeOrderState,
  RechargeOrderSummary,
} from "../../types/ops.js";

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
