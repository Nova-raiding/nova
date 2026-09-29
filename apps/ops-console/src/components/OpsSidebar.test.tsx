import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mainItems, navigationGroups, OpsSidebar } from "./OpsSidebar.js";

describe("OpsSidebar navigation", () => {
  it("uses Store Nova branding for platform operations", () => {
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("tasks");
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="users"
        onNavigate={() => undefined}
      />,
    );
    expect(markup).toContain("Store Nova");
    expect(markup).not.toContain("平台运营控制面");
    expect(markup).toContain('aria-labelledby="ops-nav-group-governance"');
    expect(markup).toContain('id="ops-nav-group-governance" class="sr-only">平台治理</h2>');
    expect(markup).not.toContain("商家工作区治理");
    expect(markup).not.toContain(">商家运营</h2>");
    expect(markup).not.toContain("模型与计费");
    expect(markup).not.toContain("风险与系统");
    expect(markup).not.toContain("当前操作范围");
    expect(markup).not.toContain("受控支持入口");
    expect(markup).not.toContain("租户作用域");
    expect(markup).not.toContain("全部平台连接");
    expect(markup).not.toContain("京东一店");
    expect(markup).not.toContain("我的店铺");
    expect(markup).not.toContain("Store Nova商家中心");
  });

  it("keeps the primary rail matched to the three screenshot destinations", () => {
    expect(navigationGroups[0]?.items).toEqual(["overview", "users", "customer-delivery"]);
    expect(navigationGroups).toHaveLength(1);
    expect(mainItems.map(({ domain }) => domain)).toEqual([
      "overview", "users", "customer-delivery", "members", "tasks", "knowledge", "stores", "rules", "models", "storage", "finance", "audit",
    ]);
  });

  it("keeps the retired model services destination out of navigation", () => {
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("models");
  });

  it("keeps member governance inside the user center", () => {
    expect(mainItems.map(({ domain }) => domain)).toContain("members");
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "users",
      label: "用户中心",
    });
  });

  it("keeps role-gated routes available in their authorized navigation group", () => {
    expect(mainItems.map(({ domain }) => domain)).toContain("rules");
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("rules");
    expect(mainItems.map(({ domain }) => domain)).not.toContain("feature-flags");
  });

  it("does not expose removed support, incident, or feature flag destinations", () => {
    expect(mainItems.map(({ domain }) => domain)).not.toEqual(expect.arrayContaining(["support", "incidents", "feature-flags"]));
  });

  it("omits destinations outside the supplied role-aware visibility set", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="users"
        visibleDomains={["users", "audit"]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).not.toContain("客服");
    expect(markup).not.toContain("事故中心");
    expect(markup).not.toContain("账务与退款");
    expect(markup).not.toContain("任务与内容");
    expect(markup).not.toContain('aria-label="平台与店铺"');
    expect(markup).not.toContain("平台规则");
    expect(markup).not.toContain("功能开关");
    expect(markup).not.toContain("风险与系统");
    expect(markup).not.toContain('aria-label="更多功能"');
    expect(markup).not.toContain('aria-label="审计中心"');
    expect(markup).not.toContain('aria-label="平台与店铺"');
    expect(markup).not.toContain('aria-label="平台规则"');
    expect(markup).not.toContain('aria-label="账务与退款"');
    expect(markup).not.toContain('aria-label="存储与对账"');
  });

  it("renders only the three screenshot destinations in the primary rail", () => {
    const markup = renderToStaticMarkup(<OpsSidebar activeDomain="overview" visibleDomains={["overview", "users", "customer-delivery", "stores", "rules", "finance", "storage", "audit"]} onNavigate={() => undefined} />);
    expect((markup.match(/class="sider-item(?: active)?"/g) ?? [])).toHaveLength(3);
    expect(markup).toContain('aria-label="总览"');
    expect(markup).toContain('aria-label="用户中心"');
    expect(markup).toContain('aria-label="客户交付"');
    for (const label of ["平台与店铺", "规则中心", "账务与退款", "审计中心", "存储治理"]) {
      expect(markup).not.toContain(`aria-label="${label}"`);
    }
    expect(mainItems.map(({ domain }) => domain)).toEqual(expect.arrayContaining(["stores", "rules", "finance", "storage", "audit"]));
  });

  it("keeps finance reachable only when it is in the server-derived visibility set", () => {
    expect(mainItems.map(({ domain }) => domain)).toContain("finance");
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("finance");
    expect(mainItems.map(({ domain }) => domain)).not.toContain("feature-flags");
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="overview"
        visibleDomains={["overview", "finance"]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="总览"');
    expect(markup).not.toContain('aria-label="用户中心"');
    expect(markup).not.toContain('aria-label="客户交付"');
    expect(markup).not.toContain('aria-label="账务与退款"');
    const restrictedMarkup = renderToStaticMarkup(
      <OpsSidebar activeDomain="users" visibleDomains={["users"]} onNavigate={() => undefined} />,
    );
    expect(restrictedMarkup).not.toContain('aria-label="账务与退款"');
    expect(restrictedMarkup).not.toContain('aria-label="更多功能"');
  });

  it("excludes retired model services and workspace-only destinations", () => {
    expect(mainItems.map(({ domain }) => domain)).toContain("models");
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("models");
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="overview"
        visibleDomains={["overview", "models"]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).not.toContain('aria-label="模型服务"');
    expect(markup).not.toContain('aria-label="成员管理"');
    expect(markup).not.toContain('aria-label="任务中心"');
  });

  it("does not render customer store scope in the platform operations navigation", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar activeDomain="stores" onNavigate={() => undefined} />,
    );
    expect(markup).not.toContain("受控支持入口");
    expect(markup).not.toContain("京东一店");
    expect(markup).not.toContain("京东二店");
    expect(markup).toContain('aria-label="关闭运营导航"');
  });

  it("shows the authoritative workspace scope instead of claiming full-platform access", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="users"
        visibleDomains={["users"]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).not.toContain("当前操作范围");
    expect(markup).toContain('id="ops-nav-group-governance" class="sr-only">平台治理</h2>');
    expect(markup).not.toContain("模型与计费");
    expect(markup).not.toContain("商家工作区治理");
    expect(markup).not.toContain("风险与系统");
    expect(markup).not.toContain("受控支持入口");
  });

});
