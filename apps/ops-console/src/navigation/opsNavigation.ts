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

/** Domains served by the platform operations console. Merchant operations are
 * handled by Merchant Studio, so the Ops Console never switches workbench. */
export function requiredWorkbenchForDomain(domain: OpsDomain): "platform" | "workspace" | undefined {
  if (["users", "customer-delivery", "stores", "models", "storage", "finance", "audit"].includes(domain)) return "platform";
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
    .match(/\/ops\/(?:governance|overview|users|customer-delivery|members|tasks|knowledge|stores|rules|models|storage|finance|audit)\/?$/u)?.[0]
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
  const currentOpsRoute =
    /\/ops\/(?:governance|overview|users|customer-delivery|members|tasks|knowledge|stores|rules|models|storage|finance|audit)\/?$/u;
  const legacyMerchantTasksRoute = /\/ops\/finance\/merchant\/tasks\/?$/u;
  const opsRootRoute = /\/ops\/?$/u;
  const unknownOpsDeepLink = /\/ops\/.*$/u;
  const basePath = currentOpsRoute.test(location.pathname)
    ? location.pathname.replace(currentOpsRoute, "")
    : legacyMerchantTasksRoute.test(location.pathname)
      ? location.pathname.replace(legacyMerchantTasksRoute, "")
      : opsRootRoute.test(location.pathname)
        ? location.pathname.replace(opsRootRoute, "")
        : unknownOpsDeepLink.test(location.pathname)
          ? location.pathname.replace(unknownOpsDeepLink, "")
          : location.pathname.replace(/\/$/u, "");
  return `${basePath}/ops/${domain}${location.search}`;
}
