export const opsDomains = [
  "overview",
  "users",
  "tasks",
  "stores",
  "models",
  "finance",
] as const;

export type OpsDomain = (typeof opsDomains)[number];

export function isOpsDomain(value: string): value is OpsDomain {
  return opsDomains.includes(value as OpsDomain);
}

export function domainFromLocation(
  location: Pick<Location, "hash" | "pathname">,
): OpsDomain {
  const pathDomain = location.pathname
    .match(/\/ops\/(?:governance|overview|users|tasks|stores|models|finance)\/?$/u)?.[0]
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
    /\/ops\/(?:governance|overview|users|tasks|stores|models|finance)\/?$/u;
  const basePath = currentOpsRoute.test(location.pathname)
    ? location.pathname.replace(currentOpsRoute, "")
    : location.pathname.replace(/\/$/u, "");
  return `${basePath}/ops/${domain}${location.search}`;
}
