import { describe, expect, it } from "vitest";
import { financePermissions } from "./financePermissions.js";

describe("financePermissions", () => {
  it("matches the API role matrix for refund, payment reconciliation, and model settlement", () => {
    expect(financePermissions(["workspace_owner"], true)).toEqual({ refund: true, paymentReconciliation: true, modelSettlement: false });
    expect(financePermissions(["merchant_admin"], true)).toEqual({ refund: true, paymentReconciliation: true, modelSettlement: false });
    expect(financePermissions(["finance"], true)).toEqual({ refund: true, paymentReconciliation: true, modelSettlement: true });
    expect(financePermissions(["platform_ops"], true)).toEqual({ refund: false, paymentReconciliation: true, modelSettlement: true });
    expect(financePermissions(["operator"], true)).toEqual({ refund: false, paymentReconciliation: false, modelSettlement: false });
  });

  it("keeps the unmanaged local console operable", () => {
    expect(financePermissions([], false)).toEqual({ refund: true, paymentReconciliation: true, modelSettlement: true });
  });
});
