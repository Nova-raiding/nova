import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import { platforms, type Platform } from "../types/ops.js";
import type { OpsDomain } from "../navigation/opsNavigation.js";

/** Navigate from a brand store node into that authorized store's task queue. */
export async function openBrandStore(
  model: Pick<OpsConsoleModel, "setQueueFilters">,
  onNavigate: (domain: OpsDomain) => void,
  platform: string,
  accountId: string,
  onNavigateWithQuery?: (domain: OpsDomain, query: Record<string, string | undefined>) => void,
) {
  if (!platforms.includes(platform as Platform) || !accountId.trim()) return false;
  const queueFilters = { platform: platform as Platform, accountId: accountId.trim() };
  model.setQueueFilters(queueFilters);
  if (onNavigateWithQuery) onNavigateWithQuery("tasks", { platform, accountId: queueFilters.accountId });
  else onNavigate("tasks");
  return true;
}
