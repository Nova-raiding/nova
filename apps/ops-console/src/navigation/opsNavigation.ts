import { canViewDomain, type AuthorizationProjection } from "../authz/authorization.js";

export const opsDomains = [
  "overview",
  "users",
  "members",
  "support",
  "incidents",
  "tasks",
  "stores",
  "rules",
  "models",
  "feature-flags",
  "storage",
  "finance",
  "audit",
] as const;

export type OpsDomain = (typeof opsDomains)[number];

/** Domains with one authoritative workbench; deep links must use that context. */
export function requiredWorkbenchForDomain(domain: OpsDomain): "platform" | "workspace" | undefined {
  if (["users", "stores", "models", "feature-flags", "storage", "finance", "audit"].includes(domain)) return "platform";
  if (["members", "tasks", "rules", "support", "incidents"].includes(domain)) return "workspace";
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
  const pathDomain = location.pathname
    .match(/\/ops\/(?:governance|overview|users|members|support|incidents|tasks|stores|rules|models|feature-flags|storage|finance|audit)\/?$/u)?.[0]
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (pathDomain === "governance") return "overview";
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
    /\/ops\/(?:governance|overview|users|members|support|incidents|tasks|stores|rules|models|feature-flags|storage|finance|audit)\/?$/u;
  const basePath = currentOpsRoute.test(location.pathname)
    ? location.pathname.replace(currentOpsRoute, "")
    : location.pathname.replace(/\/$/u, "");
  return `${basePath}/ops/${domain}${location.search}`;
}
