import { describe, expect, it, vi } from "vitest";
import { financePermissions, runAuthorizedFinanceAction } from "./financePermissions.js";

describe("financePermissions", () => {
  it.each([
    ["workspace_owner", { refund: true, paymentReconciliation: true, modelSettlement: false, billingExport: true }],
    ["merchant_admin", { refund: true, paymentReconciliation: true, modelSettlement: false, billingExport: true }],
    ["finance", { refund: true, paymentReconciliation: true, modelSettlement: true, billingExport: true }],
    ["platform_ops", { refund: false, paymentReconciliation: true, modelSettlement: true, billingExport: true }],
    ["operator", { refund: false, paymentReconciliation: false, modelSettlement: false, billingExport: false }],
    ["support", { refund: false, paymentReconciliation: false, modelSettlement: false, billingExport: false }],
    ["rules_admin", { refund: false, paymentReconciliation: false, modelSettlement: false, billingExport: false }],
  ] as const)("matches the API finance matrix for %s", (role, expected) => {
    expect(financePermissions([role], true)).toEqual(expected);
  });

  it("keeps the unmanaged local console operable", () => {
    expect(financePermissions([], false)).toEqual({ refund: true, paymentReconciliation: true, modelSettlement: true, billingExport: true });
  });

  it("allows the platform_ops model-settlement callback", async () => {
    const action = vi.fn(async () => undefined);
    const onDenied = vi.fn();

    await expect(runAuthorizedFinanceAction(
      financePermissions(["platform_ops"], true).modelSettlement,
      action,
      onDenied,
    )).resolves.toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
  });

  it("blocks unauthorized model-settlement callbacks before the request", async () => {
    const action = vi.fn(async () => undefined);
    const onDenied = vi.fn();

    await expect(runAuthorizedFinanceAction(
      financePermissions(["workspace_owner"], true).modelSettlement,
      action,
      onDenied,
    )).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledOnce();
  });

  it("blocks unauthorized billing-export callbacks before the request", async () => {
    const action = vi.fn(async () => undefined);
    const onDenied = vi.fn();

    await expect(runAuthorizedFinanceAction(
      financePermissions(["operator"], true).billingExport,
      action,
      onDenied,
    )).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledOnce();
  });
});
