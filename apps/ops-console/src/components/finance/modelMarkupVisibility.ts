export function canViewModelMarkup(roles: readonly string[]): boolean {
  return roles.includes("platform_ops");
}

export function visiblePlanBillingTabKeys(
  canModelMarkup: boolean,
): string[] {
  return [
    ...(canModelMarkup ? ["model-markup"] : []),
    "offers",
    "addons",
    "coupons",
    "rollouts",
  ];
}
