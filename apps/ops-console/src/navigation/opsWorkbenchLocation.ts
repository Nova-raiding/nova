import type { OpsWorkbench } from "../types/ops.js";

export function workbenchIntentFromLocation(
  location: Pick<Location, "search">,
): OpsWorkbench | undefined {
  const value = new URLSearchParams(location.search).get("workbench");
  return value === "platform" || value === "workspace" ? value : undefined;
}

export function urlForWorkbench(
  location: Pick<Location, "pathname" | "search" | "hash">,
  workbench: OpsWorkbench,
): string {
  const search = new URLSearchParams(location.search);
  search.set("workbench", workbench);
  const query = search.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}
