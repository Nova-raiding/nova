import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createAuthorizationProjection } from "../authz/authorization.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import { StoresPage } from "./StoresPage.js";

describe("StoresPage platform directory permission state", () => {
  it("does not present an unreadable platform directory as a real empty result", () => {
    const authorization = createAuthorizationProjection({
      actor_id: "operator", workspace_id: "ops", workbench: "platform", workspace_granted: true,
      roles: [], capabilities: ["platform.settings.read"],
    }, true);
    const model = {
      error: "",
      dataSetError: vi.fn(() => undefined),
      loading: false,
      storeDirectory: [],
      brandNavigation: [],
      platformBrandUnitSummary: undefined,
      authorization,
      canPlatformOps: true,
      opsSession: undefined,
      saveStoreAlias: vi.fn(async () => true),
      revokeStore: vi.fn(async () => undefined),
      automationPolicies: [],
      automationPolicy: undefined,
      automationScan: undefined,
      canQueue: true,
      setAutomationPolicy: vi.fn(),
      scanAutomation: vi.fn(async () => undefined),
      updateAutomation: vi.fn(async () => undefined),
      load: vi.fn(async () => undefined),
    } as unknown as OpsConsoleModel;
    const markup = renderToStaticMarkup(<StoresPage model={model} onNavigate={vi.fn()} />);

    expect(markup).toContain("平台店铺目录未读取");
    expect(markup).toContain("没有 workspace.directory.read 能力");
    expect(markup).not.toContain("暂无平台连接汇总");
    expect(markup).not.toContain("暂无已登记店铺");
  });
});
