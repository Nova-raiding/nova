import { describe, expect, it, vi } from "vitest";
import { financePermissions, runAuthorizedFinanceAction } from "./financePermissions.js";
import { createAuthorizationProjection } from "../../authz/authorization.js";

const authorization = (capabilities: string[], managed = true) => createAuthorizationProjection(
  managed ? { actor_id: "actor_1", workspace_id: "ws_1", roles: [], workspace_granted: true, capabilities } : undefined,
  managed,
);

describe("financePermissions", () => {
  it.each([
    [["billing.refund.execute", "billing.reconcile.execute", "billing.export"], { refund: true, paymentReconciliation: true, modelSettlement: true, billingExport: true }],
    [["billing.workspace.read"], { refund: false, paymentReconciliation: false, modelSettlement: false, billingExport: false }],
    [["customer.content.read"], { refund: false, paymentReconciliation: false, modelSettlement: false, billingExport: false }],
  ] as const)("matches the canonical API finance capabilities for %j", (capabilities, expected) => {
    expect(financePermissions(authorization([...capabilities]))).toEqual(expected);
  });

  it("fails closed before an unmanaged local session provides server permissions", () => {
    expect(financePermissions(authorization([], false))).toEqual({ refund: false, paymentReconciliation: false, modelSettlement: false, billingExport: false });
  });

  it("allows the platform_ops model-settlement callback", async () => {
    const action = vi.fn(async () => undefined);
    const onDenied = vi.fn();

    await expect(runAuthorizedFinanceAction(
      financePermissions(authorization(["billing.reconcile.execute"])).modelSettlement,
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
      financePermissions(authorization(["billing.workspace.read"])).modelSettlement,
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
      financePermissions(authorization(["customer.content.read"])).billingExport,
      action,
      onDenied,
    )).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledOnce();
  });
});
