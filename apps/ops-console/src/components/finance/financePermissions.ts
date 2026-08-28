export interface FinancePermissions {
  refund: boolean;
  paymentReconciliation: boolean;
  modelSettlement: boolean;
}

const hasAny = (roles: readonly string[], allowed: readonly string[]) =>
  roles.some((role) => allowed.includes(role));

export function financePermissions(
  roles: readonly string[],
  managedSession: boolean,
): FinancePermissions {
  if (!managedSession) return { refund: true, paymentReconciliation: true, modelSettlement: true };
  return {
    refund: hasAny(roles, ["workspace_owner", "merchant_admin", "finance"]),
    paymentReconciliation: hasAny(roles, ["workspace_owner", "merchant_admin", "finance", "platform_ops"]),
    modelSettlement: hasAny(roles, ["finance", "platform_ops"]),
  };
}
