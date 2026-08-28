import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { clearAlertFilters } from "./AlertFiltersSection.js";
import { clearMarketingQueueFilters } from "./MarketingQueueFiltersSection.js";

describe("Ops filter clearing", () => {
  it("loads the marketing queue with an explicit empty filter", async () => {
    const setQueueFilters = vi.fn();
    const load = vi.fn(async () => undefined);

    await clearMarketingQueueFilters({ setQueueFilters, load } as unknown as OpsConsoleModel);

    expect(setQueueFilters).toHaveBeenCalledWith({});
    expect(load).toHaveBeenCalledWith({ queueFilters: {} });
  });

  it("loads alerts with an explicit empty filter", async () => {
    const setAlertFilters = vi.fn();
    const load = vi.fn(async () => undefined);

    await clearAlertFilters({ setAlertFilters, load } as unknown as OpsConsoleModel);

    expect(setAlertFilters).toHaveBeenCalledWith({});
    expect(load).toHaveBeenCalledWith({ alertFilters: {} });
  });
});
