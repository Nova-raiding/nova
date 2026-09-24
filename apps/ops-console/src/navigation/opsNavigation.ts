import { canViewDomain, type AuthorizationProjection } from "../authz/authorization.js";

export const opsDomains = [
  "overview",
  "users",
  "customer-delivery",
  "members",
  "tasks",
  "knowledge",
  "stores",
  "rules",
  "models",
  "storage",
  "finance",
  "audit",
] as const;

export type OpsDomain = (typeof opsDomains)[number];

// Keep route recognition and route replacement aligned with the domain source
// of truth. `governance` remains a legacy alias for the overview landing page.
const opsRoutePattern = new RegExp(
  `/ops/(?:governance|${opsDomains.join("|")})/?$`,
  "u",
);

/** Domains served by the platform operations console. Merchant operations are
 * handled by Merchant Studio, so the Ops Console never switches workbench.
 *
 * `finance` is deliberately absent from both lists below, which is what makes
 * it dual-scope: `domainNavigationBlockedReason` treats an undefined
 * requirement as reachable, so 账务与退款 serves both the platform ledger and
 * the enterprise-side 账务与商业配置 view. Giving it a workbench would silently
 * drop one of those two faces, so adding it here needs a product decision. */
export function requiredWorkbenchForDomain(domain: OpsDomain): "platform" | "workspace" | undefined {
  if (["users", "customer-delivery", "stores", "models", "storage", "audit"].includes(domain)) return "platform";
  if (["members", "tasks", "knowledge", "rules"].includes(domain)) return "workspace";
  return undefined;
}

export function isOpsDomain(value: string): value is OpsDomain {
  return opsDomains.includes(value as OpsDomain);
}

export function canViewOpsDomain(
  domain: OpsDomain,
  authorization: AuthorizationProjection,
): boolean {
  return canViewDomain(authorization, domain);
}

export function visibleOpsDomains(
  authorization: AuthorizationProjection,
): OpsDomain[] {
  return opsDomains.filter((domain) => canViewOpsDomain(domain, authorization));
}

export function domainFromLocation(
  location: Pick<Location, "hash" | "pathname">,
): OpsDomain {
  // Older finance links incorrectly nested the operations task queue under
  // the finance route. Keep them usable, but canonicalize to /ops/tasks.
  if (/\/ops\/finance\/merchant\/tasks\/?$/u.test(location.pathname)) return "tasks";
  const pathDomain = location.pathname
    .match(opsRoutePattern)?.[0]
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (pathDomain === "governance") return "overview";
  if (pathDomain === "overview") return "overview";
  if (pathDomain && isOpsDomain(pathDomain)) return pathDomain;

  // Keep old bookmarked hash links working during the route migration.
  const hashDomain = location.hash.slice(1);
  if (isOpsDomain(hashDomain)) return hashDomain;
  return "overview";
}

export function urlForDomain(
  location: Pick<Location, "pathname" | "search">,
  domain: OpsDomain,
): string {
  const legacyMerchantTasksRoute = /\/ops\/finance\/merchant\/tasks\/?$/u;
  const opsRootRoute = /\/ops\/?$/u;
  const unknownOpsDeepLink = /\/ops\/.*$/u;
  const basePath = opsRoutePattern.test(location.pathname)
    ? location.pathname.replace(opsRoutePattern, "")
    : legacyMerchantTasksRoute.test(location.pathname)
      ? location.pathname.replace(legacyMerchantTasksRoute, "")
      : opsRootRoute.test(location.pathname)
        ? location.pathname.replace(opsRootRoute, "")
        : unknownOpsDeepLink.test(location.pathname)
          ? location.pathname.replace(unknownOpsDeepLink, "")
          : location.pathname.replace(/\/$/u, "");
  return `${basePath}/ops/${domain}${location.search}`;
}

export function urlForDomainWithQuery(
  location: Pick<Location, "pathname" | "search" | "hash">,
  domain: OpsDomain,
  patch: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value?.trim()) params.set(key, value.trim());
    else params.delete(key);
  }
  const route = urlForDomain(location, domain).split("?")[0];
  const query = params.toString();
  return `${route}${query ? `?${query}` : ""}${location.hash}`;
}
