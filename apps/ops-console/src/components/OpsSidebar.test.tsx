import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mainItems, navigationGroups, OpsSidebar } from "./OpsSidebar.js";

describe("OpsSidebar navigation", () => {
  it("uses Store Nova branding for platform operations", () => {
    expect(mainItems.map(({ domain }) => domain)).not.toContain("tasks");
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="users"
        stores={[]}
        platformLabels={{}}
        selectedStoreScope=""
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
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

  it("keeps the primary rail aligned to the supplied three-destination UI", () => {
    expect(navigationGroups.flatMap(({ items }) => [...items])).toEqual(["overview", "users", "customer-delivery"]);
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({ domain: "stores", label: "平台与店铺" });
  });

  it("exposes the independent model services destination", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "models",
      label: "模型服务",
    });
  });

  it("keeps member governance inside the user center", () => {
    expect(mainItems.map(({ domain }) => domain)).not.toContain("members");
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "users",
      label: "用户中心",
    });
  });

  it("keeps role-gated routes available without adding them to the primary rail", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toEqual(
      expect.arrayContaining([
        { domain: "rules", label: "平台规则" },
      ]),
    );
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("rules");
    expect(mainItems.map(({ domain }) => domain)).not.toEqual(expect.arrayContaining(["feature-flags", "storage", "audit"]));
  });

  it("does not expose removed support, incident, or feature flag destinations", () => {
    expect(mainItems.map(({ domain }) => domain)).not.toEqual(expect.arrayContaining(["support", "incidents", "feature-flags"]));
  });

  it("omits destinations outside the supplied role-aware visibility set", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="users"
        stores={[]}
        platformLabels={{}}
        selectedStoreScope=""
        visibleDomains={["users", "stores", "audit"]}
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
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
    expect(markup).not.toContain("存储与对账");
    expect(markup).not.toContain("审计中心");
  });

  it("renders only the three primary destinations shown in the reference UI", () => {
    const markup = renderToStaticMarkup(<OpsSidebar activeDomain="overview" stores={[]} platformLabels={{}} selectedStoreScope="" onNavigate={() => undefined} onSelectStore={() => undefined} />);
    expect((markup.match(/class="sider-item(?: active)?"/g) ?? [])).toHaveLength(3);
    expect(markup).toContain('aria-label="总览"');
    expect(markup).toContain('aria-label="用户中心"');
    expect(markup).toContain('aria-label="客户交付"');
    expect(markup).not.toContain('aria-label="平台与店铺"');
    expect(markup).not.toContain('aria-label="平台规则"');
    expect(markup).not.toContain('aria-label="账务与退款"');
  });

  it("renders finance navigation only when the authorization visibility set includes it", () => {
    expect(mainItems.map(({ domain }) => domain)).toContain("finance");
    expect(mainItems.map(({ label }) => label)).toContain("账务与退款");
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("finance");
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="overview"
        stores={[]}
        platformLabels={{}}
        selectedStoreScope=""
        visibleDomains={["overview", "finance"]}
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="总览"');
    expect(markup).not.toContain('aria-label="用户中心"');
    expect(markup).not.toContain('aria-label="客户交付"');
    expect(markup).not.toContain('aria-label="账务与退款"');
    expect(markup).not.toContain('aria-labelledby="ops-nav-group-model-billing"');
    expect(markup).not.toContain("模型与计费");
    const restrictedMarkup = renderToStaticMarkup(
      <OpsSidebar activeDomain="users" stores={[]} platformLabels={{}} selectedStoreScope="" visibleDomains={["users"]} onNavigate={() => undefined} onSelectStore={() => undefined} />,
    );
    expect(restrictedMarkup).not.toContain('aria-label="账务与退款"');
  });

  it("keeps the model services entry out of the rendered platform navigation", () => {
    // `models` is intentionally retained in `mainItems` for backwards-compatible
    // labels, but 365c5d84 left it out of `navigationGroups`, so the sidebar
    // renders no button for it. The browser walk in ops-all.spec.js asserts the
    // same absence; this pins it at the unit level.
    expect(mainItems.map(({ domain }) => domain)).toContain("models");
    expect(navigationGroups.flatMap(({ items }) => [...items])).not.toContain("models");
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="overview"
        stores={[]}
        platformLabels={{}}
        selectedStoreScope=""
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
      />,
    );
    expect(markup).not.toContain("模型服务");
  });

  it("does not render customer store scope in the platform operations navigation", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar activeDomain="stores" stores={[{ platform: "jd", accountId: "store-1", label: "京东一店", state: "connected" }, { platform: "jd", accountId: "store-2", label: "京东二店", state: "refresh_required" }]} platformLabels={{ jd: "京东" }} selectedStoreScope="jd:store-1" onNavigate={() => undefined} onSelectStore={() => undefined} />,
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
        stores={[]}
        platformLabels={{}}
        selectedStoreScope=""
        visibleDomains={["users"]}
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
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
