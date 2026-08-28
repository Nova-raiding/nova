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
      : /\.tsx?$/u.test(entry.name)
        ? [readFileSync(child, "utf8")]
        : [];
  });
}

const app = opsSources(new URL("../apps/ops-console/src/", import.meta.url))
  .join("\n")
  .replaceAll('"', "'")
  .replace(/\s+/g, " ");
const appEntry = readFileSync(
  new URL("../apps/ops-console/src/App.tsx", import.meta.url),
  "utf8",
);
const viteConfig = readFileSync(
  new URL("../apps/ops-console/vite.config.ts", import.meta.url),
  "utf8",
);

describe("Ops console marketing governance contract", () => {
  it("keeps the marketing governance projection in the Ant Design console", () => {
    expect(app).toContain("营销能力运营治理");
    expect(app).toContain("optional('knowledge.rule.list')");
    expect(app).toContain("optional('knowledge.asset.list')");
    expect(app).toContain(
      "optional('knowledge.learning.list', { status: 'pending' })",
    );
    expect(app).toContain("optional('knowledge.competitor.list')");
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
    expect(app).toContain(
      "rpc(method, { asset_id: asset.id, scan_evidence_ref: evidence })",
    );
    expect(app).toContain("asset_id: asset.id");
    expect(app).toContain("rights_status: rightsStatus");
    expect(app).toContain("rights_scope: rightsScope");
    expect(app).toContain("录入竞品参考");
    expect(app).toContain("不会自动激活全局规则");
    expect(app).toContain("仅差异化参考");
    expect(app).toContain("生成失败");
  });

  it("keeps each operations domain failure-isolated", () => {
    expect(app).toContain("optional('workspace.commercial.get')");
    expect(app).toContain("optional('workspace.health')");
    expect(app).toContain("optional('ops.marketing.queue', { limit: '50',");
    expect(app).toContain(
      "optional('ops.alerts.list', { status: 'open', limit: '100',",
    );
    expect(app).toContain("平台告警筛选");
    expect(app).toContain("alertFilters.entityId");
    expect(app).toContain("rpc('ops.marketing.generation.retry'");
    expect(app).toContain("rpc('ops.marketing.publish.acknowledge'");
    expect(app).toContain("rpc('ops.marketing.revision.create'");
    expect(app).toContain("body.data?.result ?? body.result");
    expect(app).toContain(
      "generation: [], publish: [], visuals: [], batches: [], learningSuggestions: [], assetRisks: [], uploadedAssetRisks: []",
    );
    expect(app).toContain("storeDirectory?: StoreDirectory[]");
    expect(app).toContain("绑定店铺与授权状态");
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
    expect(app).toContain("if (!canPlatformOps)");
    expect(app).toContain("message.error('当前会话为只读，缺少商业配置权限')");
  });

  it("uses routed page components instead of Ant Space child indexes", () => {
    expect(app).not.toContain(
      "querySelectorAll<HTMLElement>('.content-stack > .ant-card')",
    );
    expect(app).toContain("const ActivePage = opsPageRegistry[activeDomain]");
    expect(app).toContain("overview: lazy(() => import('../pages/OverviewPage.js')");
    expect(app).toContain("tasks: lazy(() => import('../pages/TasksPage.js')");
    expect(app).toContain("stores: lazy(() => import('../pages/StoresPage.js')");
    expect(app).toContain("finance: lazy(() => import('../pages/FinancePage.js')");
    expect(app).toContain("users: lazy(async () => ({ default: UsersPage }))");
    expect(app).toContain("['overview', 'users', 'tasks', 'stores', 'finance']");
    expect(app).toContain("activeDomain === 'finance'");
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
      "const raw = await readBoundedResponseText(response, MAX_OPS_RESPONSE_BYTES)",
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
