import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function opsSources(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    return entry.isDirectory()
      ? opsSources(child)
      : /\.tsx?$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name)
        ? [readFileSync(child, "utf8")]
        : [];
  });
}

const normalizeSource = (source: string) => source
  .replaceAll('"', "'")
  .replace(/\s+/g, " ");

const app = normalizeSource(
  opsSources(new URL("../apps/ops-console/src/", import.meta.url)).join("\n"),
);
const appEntry = readFileSync(
  new URL("../apps/ops-console/src/App.tsx", import.meta.url),
  "utf8",
);
const controller = normalizeSource(readFileSync(
  new URL("../apps/ops-console/src/pages/OpsConsoleController.tsx", import.meta.url),
  "utf8",
));
const registry = normalizeSource(readFileSync(
  new URL("../apps/ops-console/src/navigation/opsPageRegistry.tsx", import.meta.url),
  "utf8",
));
const model = normalizeSource(readFileSync(
  new URL("../apps/ops-console/src/hooks/useOpsConsoleModel.ts", import.meta.url),
  "utf8",
));
const viteConfig = readFileSync(
  new URL("../apps/ops-console/vite.config.ts", import.meta.url),
  "utf8",
);

describe("Ops console marketing governance contract", () => {
  it("keeps the marketing governance projection in the Ant Design console", () => {
    expect(app).toContain("营销能力运营治理");
    expect(model).toContain("authorizedOptional('knowledge.rule.list')");
    expect(model).toContain("authorizedOptional('knowledge.asset.list')");
    expect(model).toContain(
      "authorizedOptional('knowledge.learning.list', { status: 'pending' })",
    );
    expect(model).toContain("authorizedOptional('knowledge.competitor.list')");
    expect(app).toContain("rpc('knowledge.learning.confirm'");
    expect(app).toContain("rpc('knowledge.rule.create'");
    expect(app).toContain("rpc('knowledge.asset.create'");
    expect(app).toContain("rpc('knowledge.asset.update'");
    expect(app).toContain("rpc('knowledge.learning.dismiss'");
    expect(app).toContain("rpc('knowledge.competitor.create'");
    expect(app).toContain("录入知识规则");
    expect(app).toContain("录入资产");
    expect(app).toContain("确认权益");
    expect(app).toContain("驳回建议");
    expect(app).toContain("上传素材治理动作");
    expect(app).not.toContain('scan_evidence_ref');
    expect(app).toContain('平台自动安全扫描中');
    expect(app).toContain("asset_id: asset.id");
    expect(app).toContain("rights_status: rightsStatus");
    expect(app).toContain("rights_scope: rightsScope");
    expect(app).toContain("录入竞品参考");
    expect(app).toContain("不会自动激活全局规则");
    expect(app).toContain("仅差异化参考");
    expect(app).toContain("生成失败");
  });

  it("keeps each operations domain failure-isolated", () => {
    expect(app).toContain("export function dataSetErrorFor(");
    expect(app).toContain("model.dataSetError('workspace.health'");
    expect(app).toContain('model.dataSetError(');
    expect(app).toContain("model.dataSetError('platform.model.status'");
    expect(model).toContain("authorizedOptional('workspace.commercial.get')");
    expect(model).toContain("authorizedOptional('workspace.health')");
    expect(model).toContain("authorizedOptional('ops.marketing.queue', marketingQueueParams(activeQueueFilters))");
    expect(model).toContain("authorizedOptional('ops.alerts.list', alertListParams(activeAlertFilters, platformAlertScope))");
    expect(app).toContain('export function marketingQueueParams(filters: QueueFilters)');
    expect(app).toContain('export function alertListParams(filters: AlertFilters, platformScope = false)');
    expect(app).toContain("平台告警筛选");
    expect(app).toContain("alertFilters.entityId");
    expect(app).toContain("rpc('ops.marketing.generation.retry'");
    expect(app).toContain("rpc('ops.marketing.publish.acknowledge'");
    expect(app).toContain("rpc('ops.marketing.revision.create'");
    expect(app).toContain("export async function rpcWithMeta");
    expect(app).toContain("成功响应缺少 result");
    expect(app).toContain(
      "generation: [], publish: [], visuals: [], batches: [], learningSuggestions: [], assetRisks: [], uploadedAssetRisks: []",
    );
    expect(app).toContain("storeDirectory?: StoreDirectory[]");
    expect(app).toContain("平台连接与授权健康");
    expect(app).toContain("店铺目录读取失败");
    expect(app).toContain("storeDirectory.length === 0");
    expect(app).toContain("rpc('platform.store.alias.set'");
    expect(app).toContain("rpc('platform.revoke'");
    expect(app).toContain("自动化运营作用域");
    expect(app).toContain("automationScopeParams");
    expect(app).toContain("platform: row.platform, account_id: row.accountId");
    expect(app).toContain("自动商品同步");
    expect(app).toContain(
      "sync_enabled: String(current?.syncEnabled ?? false)",
    );
    expect(app).toContain("rpc('automation.policy.update'");
    expect(app).toContain("rpc('automation.scan'");
    expect(app).toContain("立即扫描");
    expect(app).toContain("保存策略");
    expect(app).toContain("不会无人值守自动重发");
    expect(app).toContain("disabled={!canQueue}");
  });

  it("keeps platform operators on aggregate data sources", () => {
    expect(model).toContain("const platformOperator = resolvedAuthorization.scope.kind === 'platform';");
    expect(model).toContain("platformOperator ? authorizedOptional('ops.audit.platform.list', { limit: '50' }) : authorizedOptional('ops.audit.list'");
    expect(model).toContain("platformOperator ? Promise.resolve(undefined) : authorizedOptional('ops.members.list')");
    expect(model).toContain("platformOperator ? Promise.resolve(undefined) : authorizedOptional('workspace.health')");
    expect(model).toContain("platformOperator ? Promise.resolve(undefined) : authorizedOptional('workspace.metrics')");
    expect(model).toContain("setPlatformOperations(items as unknown as PlatformOperation[])");
  });

  it("does not put model credentials into the governance projection", () => {
    expect(app).not.toContain("AI_API_KEY");
    expect(app).not.toContain("refresh_token");
    expect(app).not.toContain("access_token");
    expect(app).toContain("VITE_OPS_AUTH_MODE === 'oidc'");
    expect(app).toContain(
      "credentials: managedOpsSession ? 'include' : 'same-origin'",
    );
  });

  it("keeps client-side role guards on queue, automation, and commercial writes", () => {
    expect(app).toContain("if (!canQueue)");
    expect(app).toContain("message.error('当前会话为只读，缺少队列权限')");
    expect(app).toContain(
      "message.error('当前会话为只读，缺少自动化运营权限')",
    );
    expect(app).toContain("if (!canGlobalCommercial)");
    expect(app).toContain("message.error('当前会话为只读，缺少商业配置权限')");
  });

  it("uses routed page components instead of Ant Space child indexes", () => {
    expect(app).not.toContain(
      "querySelectorAll<HTMLElement>('.content-stack > .ant-card')",
    );
    expect(controller).toContain("const ActivePage = opsPageRegistry[activeDomain]");
    expect(registry).toContain("overview: lazy(() => import('../pages/OverviewPage.js')");
    expect(registry).toContain("tasks: lazy(() => import('../pages/TasksPage.js')");
    expect(registry).toContain("stores: lazy(() => import('../pages/StoresPage.js')");
    expect(registry).toContain("finance: lazy(() => import('../pages/FinancePage.js')");
    expect(registry).toContain("models: lazy(() => import('../pages/ModelsPage.js')");
    expect(registry).toContain("users: lazy(async () => ({ default: UsersPage }))");
    expect(controller).toContain("const visibleDomains = visibleOpsDomains(model.authorization)");
    expect(registry).toContain("import('./routes/SupportRoute.js')");
    expect(registry).toContain("import('./routes/IncidentsRoute.js')");
    expect(registry).toContain("import('./routes/FeatureFlagsRoute.js')");
    expect(controller).toContain("const authorized = sessionReady && canViewOpsDomain(activeDomain, model.authorization)");
    expect(controller).toContain("aria-label='正在验证运营权限'");
    expect(controller).toContain("id='ops-main-content'");
    expect(controller).toContain("const ActivePage = opsPageRegistry[activeDomain]");
    expect(app).toContain("`${basePath}/ops/${domain}${location.search}`");
    expect(app).toContain(
      "aria-current={activeDomain === item.domain ? 'page' : undefined}",
    );
    expect(appEntry.split("\n").length).toBeLessThan(10);
  });

  it("bounds API outage waits through the full response-body read", () => {
    expect(app).toContain("OPS_REQUEST_TIMEOUT_MS = 10_000");
    expect(app).toContain("MAX_OPS_RESPONSE_BYTES = 4 * 1024 * 1024");
    expect(app).toContain("new AbortController()");
    expect(app).toContain(
      "const raw = await readBoundedResponseText(response, options.maxResponseBytes ?? MAX_OPS_RESPONSE_BYTES)",
    );
    expect(app).toContain("运营 API 响应超过安全大小限制");
    expect(app).toContain("new Error('运营 API 请求超时')");
    expect(app).toContain("error.code = 'API_REQUEST_TIMEOUT'");
  });

  it("keeps the Ant Design vendor bundle split into loadable chunks", () => {
    expect(viteConfig).toContain("id.includes('/node_modules/antd/es/')");
    expect(viteConfig).toContain("`antd-${component}`");
    expect(viteConfig).toContain("return 'antd-icons'");
  });
});
