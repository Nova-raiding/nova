import { describe, expect, it, vi } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { AlertFiltersSection, clearAlertFilters } from "./AlertFiltersSection.js";
import { clearMarketingQueueFilters, MarketingQueueFiltersSection } from "./MarketingQueueFiltersSection.js";

describe("Ops filter clearing", () => {
  it("gives every task filter control an accessible name", () => {
    const model = {
      alertFilters: {}, queueFilters: {}, storeDirectory: [],
      setAlertFilters: vi.fn(), setQueueFilters: vi.fn(), load: vi.fn(),
    } as unknown as OpsConsoleModel;
    const markup = renderToStaticMarkup(createElement(Fragment, undefined,
      createElement(MarketingQueueFiltersSection, { model }),
      createElement(AlertFiltersSection, { model }),
    ));
    for (const label of [
      "按营销队列平台筛选", "按营销队列店铺筛选", "按营销队列商品 ID 筛选", "按营销队列任务 ID 筛选", "按营销队列状态筛选",
      "按告警平台筛选", "按告警店铺筛选", "按告警编码筛选", "按告警对象类型筛选", "按告警对象 ID 筛选",
    ]) expect(markup).toContain(`aria-label="${label}"`);
  });

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
