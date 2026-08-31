import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { App as AntApp } from "antd";
import { OpsAntAppBoundary, opsSessionGateState, selectStoreScope } from "./OpsConsoleController.js";
import { openBrandStore } from "./StoresPage.js";

describe("selectStoreScope", () => {
  it("updates the selected store and loads its automation scope", async () => {
    const setSelectedStoreScope = vi.fn();
    const loadAutomationScope = vi.fn(async () => undefined);

    await expect(selectStoreScope(
      { setSelectedStoreScope, loadAutomationScope },
      "douyin:store-2",
    )).resolves.toBeUndefined();
    expect(setSelectedStoreScope).toHaveBeenCalledWith("douyin:store-2");
    expect(loadAutomationScope).toHaveBeenCalledWith("douyin:store-2");
  });
});

describe("Ops Ant Design runtime provider", () => {
  it("provides a callable message error API to model error paths", () => {
    function ErrorPathProbe() {
      const { message } = AntApp.useApp();
      message.error("模拟模型加载失败");
      return createElement("span", null, "error handled");
    }

    expect(() => renderToStaticMarkup(createElement(
      OpsAntAppBoundary,
      null,
      createElement(ErrorPathProbe),
    ))).not.toThrow();
  });
});

describe("managed session gate", () => {
  it("blocks deep links when ops.session failed instead of treating them as loading or empty", () => {
    expect(opsSessionGateState(true, false, "OIDC session projection failed")).toBe("blocked");
    expect(opsSessionGateState(true, false)).toBe("loading");
    expect(opsSessionGateState(true, true, "stale error")).toBe("ready");
    expect(opsSessionGateState(false, false, "local connection error")).toBe("ready");
  });
});

describe("openBrandStore", () => {
  it("sets the exact store queue scope, navigates to tasks, and refreshes", async () => {
    const setQueueFilters = vi.fn();
    const load = vi.fn(async () => undefined);
    const onNavigate = vi.fn();

    await expect(openBrandStore({ setQueueFilters, load }, onNavigate, "taobao", "store-1")).resolves.toBe(true);

    expect(setQueueFilters).toHaveBeenCalledWith({ platform: "taobao", accountId: "store-1" });
    expect(onNavigate).toHaveBeenCalledWith("tasks");
    expect(load).toHaveBeenCalledWith({ queueFilters: { platform: "taobao", accountId: "store-1" } });
    await expect(openBrandStore({ setQueueFilters, load }, onNavigate, "unknown", "store-1")).resolves.toBe(false);
    expect(setQueueFilters).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
