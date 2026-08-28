import { describe, expect, it } from "vitest";
import type { RechargeOrder } from "../../types/ops.js";
import {
  rechargeOrderCount,
  rechargeOrderListParams,
  rechargeOrderTotal,
  safePaymentUrl,
} from "./rechargeOrders.js";

const orders = [
  { id: "recharge_1", state: "pending" },
  { id: "recharge_2", state: "paid" },
  { id: "recharge_3", state: "paid" },
] as RechargeOrder[];

describe("recharge order presentation", () => {
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
