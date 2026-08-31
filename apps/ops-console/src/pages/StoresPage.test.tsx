import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { StoresPage } from "./StoresPage.js";
import { createAuthorizationProjection } from "../authz/authorization.js";

const workspaceAuthorization = createAuthorizationProjection({ actor_id: "owner", workspace_id: "ws_a", roles: [], workspace_granted: true, capabilities: ["store.connection.read", "store.connection.update", "automation.read", "automation.update", "customer.content.read"] }, true);

const model = (overrides: Partial<OpsConsoleModel> = {}) => ({
  error: "",
  dataSetError: vi.fn(() => undefined),
  loading: false,
  storeDirectory: [],
  brandNavigation: [],
  platformBrandUnitSummary: undefined,
      authorization: workspaceAuthorization,
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
  ...overrides,
}) as unknown as OpsConsoleModel;

describe("StoresPage", () => {
  it("mounts the directory, policy, and scan sections with real model data", () => {
    const store = {
      platform: "jd" as const,
      accountId: "store-real-1",
      label: "京东真实店铺",
      state: "connected",
      dataMode: "official_api",
      readable: true,
      writeEnabled: false,
      revision: 2,
    };
    const policy = {
      id: "policy-1",
      platform: "jd" as const,
      accountId: store.accountId,
      enabled: true,
      mode: "assisted",
      frequencyMinutes: 60,
      retryLimit: 2,
      revision: 3,
      store,
    };
    const markup = renderToStaticMarkup(<StoresPage model={model({
      storeDirectory: [store],
      automationPolicies: [policy],
      automationPolicy: policy,
      automationScan: {
        counts: { products: 12, publishJobs: 2, risks: 1 },
        risks: [{ kind: "authorization", message: "授权即将过期", product_id: "product-1" }],
        recommendations: [{ id: "rec-1", kind: "authorization", priority: "high", title: "更新店铺授权", action: "重新授权后再扫描", method: "platform.oauth.start", parameters: {}, execution: "interactive_confirmation", requiresInteractiveConfirmation: true }],
        unattendedAutoResubmit: false,
      },
    })} onNavigate={vi.fn()} />);

    expect(markup).toContain("平台连接与授权健康");
    expect(markup).toContain("品牌、平台与店铺");
    expect(markup).toContain("品牌治理聚合");
    expect(markup).toContain("京东真实店铺");
    expect(markup).toContain("已配置的店铺自动化策略");
    expect(markup).toContain("assisted");
    expect(markup).toContain("店铺优化建议");
    expect(markup).toContain("更新店铺授权");
    expect(markup).toContain("店铺自动化运营");
  });

  it("renders explicit empty states instead of inventing store or automation facts", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model()} onNavigate={vi.fn()} />);

    expect(markup).toContain("暂无已登记店铺");
    expect(markup).toContain("暂无自动化策略");
    expect(markup).toContain("尚未取得扫描结果");
    expect(markup).toContain("尚未配置自动化策略");
    expect(markup).not.toContain("真实授权");
  });

  it("renders the workspace-scoped brand tree from the API capability card", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      brandNavigation: [{
        id: "brand-1",
        title: "山野品牌",
        platforms: [{ id: "brand-1:taobao", platform: "taobao", title: "淘宝", stores: [{ id: "brand-1:taobao:store-1", accountId: "store-1" }] }],
      }],
    })} onNavigate={vi.fn()} />);

    expect(markup).toContain("山野品牌");
    expect(markup).toContain("淘宝");
    expect(markup).toContain("store-1");
    expect(markup).toContain("查看淘宝店铺 store-1 的任务");
  });

  it("offers binding only for readable, unbound workspace stores", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      authorization: createAuthorizationProjection({ workspace_id: "ws_a", roles: [], actor_id: "owner", workspace_granted: true, capabilities: ["customer.content.read", "customer.content.update"] }, true),
      brandNavigation: [{ id: "brand-1", title: "山野品牌", revision: 4, platforms: [{ id: "brand-1:taobao", platform: "taobao", title: "淘宝", stores: [{ id: "bound", accountId: "bound-store" }] }] }],
      storeDirectory: [
        { platform: "jd", accountId: "available-store", label: "可绑定店铺", state: "connected", dataMode: "official_api", readable: true, writeEnabled: false, revision: 1 },
        { platform: "taobao", accountId: "bound-store", label: "已绑定店铺", state: "connected", dataMode: "official_api", readable: true, writeEnabled: false, revision: 1 },
        { platform: "tmall", accountId: "revoked-store", label: "已撤销店铺", state: "revoked", dataMode: "official_api", readable: false, writeEnabled: false, revision: 1 },
      ],
    })} onNavigate={vi.fn()} />);

    expect(markup).toContain("绑定已授权店铺");
    expect(markup).toContain("选择平台店铺");
    expect(markup).toContain("绑定店铺");
    expect(markup).not.toContain("已绑定店铺（bound-store）");
    expect(markup).not.toContain("已撤销店铺（revoked-store）");
  });

  it("renders only redacted platform brand counts", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      platformBrandUnitSummary: { scope: "platform", workspaceCount: 2, brandCount: 3, boundStoreCount: 4, unboundBrandCount: 1, canonicalProductCount: 5, listingCount: 6, workspaces: [] },
    })} onNavigate={vi.fn()} />);
    expect(markup).toContain("平台级脱敏");
    expect(markup).toContain("品牌数");
    expect(markup).toContain("仅展示数量和链路健康");
  });

  it("does not render customer brand details for a platform operations session", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      opsSession: { workspace_id: "ops", roles: ["platform_ops"], actor_id: "operator", workspace_granted: true },
      authorization: createAuthorizationProjection({ workspace_id: "ops", roles: ["platform_ops"], canonical_roles: ["ops_admin"], actor_id: "operator", workspace_granted: true, capabilities: ["platform.settings.read", "canonical.backfill.read"] }, true),
      brandNavigation: [{ id: "brand-secret", title: "不应展示", platforms: [] }],
      platformBrandUnitSummary: { scope: "platform", workspaceCount: 1, brandCount: 1, boundStoreCount: 0, unboundBrandCount: 1, canonicalProductCount: 0, listingCount: 0, workspaces: [] },
    })} onNavigate={vi.fn()} />);

    expect(markup).not.toContain("不应展示");
    expect(markup).toContain("品牌治理聚合");
    expect(markup).toContain("平台级脱敏");
  });

  it("does not mount the platform-only canonical conflict queue in a workspace session", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      authorization: createAuthorizationProjection({ workspace_id: "ws_a", roles: [], actor_id: "owner", workspace_granted: true, capabilities: ["canonical.backfill.read", "canonical.backfill.update", "customer.content.read"] }, true),
      brandNavigation: [{ id: "brand-1", title: "山野品牌", platforms: [] }],
    })} onNavigate={vi.fn()} />);

    expect(markup).not.toContain("Canonical 回填人工冲突队列");
  });

  it("keeps a brand tree API failure distinct from an empty workspace", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      dataSetError: vi.fn((method: string) => method === "workspace.health" ? "workspace health unavailable" : undefined),
    })} onNavigate={vi.fn()} />);

    expect(markup).toContain("品牌树读取失败");
    expect(markup).toContain("workspace health unavailable");
    expect(markup).not.toContain("当前工作区还没有可访问的品");
  });

  it("distinguishes missing brand read permission from an empty workspace", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      authorization: createAuthorizationProjection({ workspace_id: "ws_a", roles: [], actor_id: "member", workspace_granted: true, capabilities: [] }, true),
    })} onNavigate={vi.fn()} />);

    expect(markup).toContain("当前账号无权读取品牌树");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("这不是空结果");
    expect(markup).not.toContain("当前工作区还没有可访问的品牌");
  });

  it("announces load failures and does not relabel them as zero records", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      error: "数据库连接失败",
      dataSetError: vi.fn(() => "数据库连接失败"),
    })} onNavigate={vi.fn()} />);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("店铺目录读取失败");
    expect(markup).toContain("自动化策略读取失败");
    expect(markup).toContain("自动化状态读取失败");
    expect(markup).toContain("数据库连接失败");
    expect(markup).not.toContain("0 个已登记店铺");
  });

  it("does not leak an unrelated operations-domain failure into store sections", () => {
    const markup = renderToStaticMarkup(<StoresPage model={model({
      error: "审计中心仓储不可用",
      dataSetError: vi.fn(() => undefined),
    })} onNavigate={vi.fn()} />);

    expect(markup).not.toContain("审计中心仓储不可用");
    expect(markup).not.toContain("店铺目录读取失败");
    expect(markup).toContain("暂无已登记店铺");
  });
});
