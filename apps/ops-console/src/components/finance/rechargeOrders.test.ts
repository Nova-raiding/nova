import { describe, expect, it } from "vitest";
import type { RechargeOrder } from "../../types/ops.js";
import {
  rechargeOrderCount,
  rechargeOrderListParams,
  rechargeOrderTotal,
  safePaymentUrl,
  paymentReconciliationOutcome,
  paymentQueryOutcome,
} from "./rechargeOrders.js";

const orders = [
  { id: "recharge_1", state: "pending" },
  { id: "recharge_2", state: "paid" },
  { id: "recharge_3", state: "paid" },
] as RechargeOrder[];

describe("recharge order presentation", () => {
  it("only treats an explicit completed reconciliation as success", () => {
    expect(paymentReconciliationOutcome({ state: "completed", settled: [] })).toEqual({ level: "success", message: "支付对账完成：入账 0" });
    expect(paymentReconciliationOutcome({ state: "unknown", settled: [] }).level).toBe("error");
    expect(paymentReconciliationOutcome({ skipped_fixture_orders: 1, settled: [], pending: [], failed: [] }).level).toBe("error");
  });
  it("does not treat fixture or unknown order query states as payment success", () => {
    expect(paymentQueryOutcome({ state: "paid", payment_mode: "fixture" }).level).toBe("info");
    expect(paymentQueryOutcome({ state: "unknown", payment_mode: "provider" }).level).toBe("error");
    expect(paymentQueryOutcome({ state: "paid", payment_mode: "provider" })).toEqual({ level: "success", message: "订单已由服务端确认到账" });
  });
  it("prefers API summary counts and falls back to visible rows", () => {
    expect(rechargeOrderCount("paid", { by_state: { paid: 12 } }, orders)).toBe(12);
    expect(rechargeOrderCount("paid", { paid: 8 }, orders)).toBe(8);
    expect(rechargeOrderCount("paid", undefined, orders)).toBe(2);
    expect(rechargeOrderTotal({ total: 20 }, orders)).toBe(20);
    expect(rechargeOrderTotal(undefined, orders, 101)).toBe(101);
    expect(rechargeOrderTotal(undefined, orders)).toBe(3);
  });

  it("uses the API states parameter for status filtering", () => {
    expect(rechargeOrderListParams()).toEqual({ limit: "100" });
    expect(rechargeOrderListParams("paid")).toEqual({ limit: "100", states: "paid" });
  });

  it("only exposes http payment links", () => {
    expect(safePaymentUrl("https://pay.example.com/order/1")).toBe(
      "https://pay.example.com/order/1",
    );
    expect(safePaymentUrl("javascript:alert(1)")).toBeUndefined();
    expect(safePaymentUrl("not-a-url")).toBeUndefined();
    expect(safePaymentUrl(null)).toBeUndefined();
  });
});
