import type { AuthorizationProjection } from "../../authz/authorization.js";

export interface FinancePermissions {
  refund: boolean;
  paymentReconciliation: boolean;
  modelSettlement: boolean;
  billingExport: boolean;
}

export function financePermissions(
  authorization: AuthorizationProjection,
): FinancePermissions {
  return {
    refund: authorization.can("billing.refund.execute"),
    paymentReconciliation: authorization.can("billing.reconcile.execute"),
    modelSettlement: authorization.can("billing.reconcile.execute"),
    billingExport: authorization.can("billing.export"),
  };
}

export async function runAuthorizedFinanceAction(
  authorized: boolean,
  action: () => Promise<void>,
  onDenied: () => void,
): Promise<boolean> {
  if (!authorized) {
    onDenied();
    return false;
  }
  await action();
  return true;
}
