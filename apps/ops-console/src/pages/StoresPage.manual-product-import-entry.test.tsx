import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createAuthorizationProjection } from "../authz/authorization.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import { StoresPage } from "./StoresPage.js";

function storesModel(scope: "platform" | "workspace", canImport: boolean) {
  const workspaceDirectory = {
    items: [{
      workspaceId: "ws_demo",
      enterpriseName: "Demo 商家",
      status: "active",
      planName: "demo",
      monthlyPriceCny: 0,
      usedTasks: 0,
      includedTasks: 0,
      subscriptionStatus: "active",
      memberCount: 1,
    }],
  };
  const opsSession = {
    workspace_id: scope === "platform" ? "ops" : "ws_demo",
    workbench: scope,
    roles: scope === "platform" ? ["platform_ops"] : ["merchant_admin"],
    actor_id: "operator",
    workspace_granted: true,
    capabilities: canImport ? ["customer.manual_import"] : [],
  };
  return {
    error: "",
    dataSetError: () => undefined,
    loading: false,
    storeDirectory: [],
    brandNavigation: [],
    platformBrandUnitSummary: undefined,
    automationPolicies: [],
    automationPolicy: undefined,
    automationScan: undefined,
    workspaceDirectory,
    opsSession,
    authorization: createAuthorizationProjection(opsSession, true),
    canPlatformOps: scope === "platform",
    saveStoreAlias: vi.fn(async () => true),
    revokeStore: vi.fn(async () => undefined),
    setAutomationPolicy: vi.fn(),
    scanAutomation: vi.fn(async () => undefined),
    updateAutomation: vi.fn(async () => undefined),
    load: vi.fn(async () => undefined),
  } as unknown as OpsConsoleModel;
}

describe("StoresPage manual customer-product import entry", () => {
  const render = (scope: "platform" | "workspace", canImport: boolean) =>
    renderToStaticMarkup(<StoresPage model={storesModel(scope, canImport)} onNavigate={vi.fn()} />);

  it("connects the platform-only route and customer.manual_import capability to the merchant uploader", () => {
    const allowed = render("platform", true);
    const denied = render("platform", false);
    const workspace = render("workspace", true);

    expect(allowed).toContain("运营代商家上传店铺商品");
    expect(allowed).toContain("选择商家工作区");
    expect(denied).not.toContain("运营代商家上传店铺商品");
    expect(workspace).not.toContain("运营代商家上传店铺商品");
  });
});
