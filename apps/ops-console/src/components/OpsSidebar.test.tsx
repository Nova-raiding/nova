import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mainItems, navigationGroups, OpsSidebar } from "./OpsSidebar.js";

describe("OpsSidebar navigation", () => {
  it("uses Store Nova branding for platform operations", () => {
    expect(mainItems.map(({ domain }) => domain)).not.toEqual(expect.arrayContaining(["tasks", "stores", "rules"]));
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
    expect(markup).not.toContain("平台治理");
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

  it("exposes platform rules as a first-class operations destination", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toEqual(
      expect.arrayContaining([
      ]),
    );
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
        visibleDomains={["users", "audit"]}
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
      />,
    );
    expect(markup).not.toContain("客服");
    expect(markup).not.toContain("事故中心");
    expect(markup).not.toContain("账务与退款");
    expect(markup).not.toContain("任务与内容");
    expect(markup).not.toContain("平台连接");
    expect(markup).not.toContain("平台规则");
    expect(markup).not.toContain("功能开关");
    expect(markup).not.toContain("风险与系统");
    expect(markup).not.toContain("存储与对账");
    expect(markup).not.toContain("审计中心");
  });

  // This assertion used to pin the opposite product fact. 365c5d84 removed
  // `finance` from `opsDomains`, from `domainReadCapabilities` and from
  // `navigationGroups`, and deleted FinancePage; the gate that replaced it was
  // written so that "restoring the destination turns this red and forces the
  // decision back through review". That is exactly what happened: the owner
  // restored the finance domain on 2026-09-20
  // (docs/qa/four-product-decisions-2026-09-20.md, option A). The models half
  // of that withdrawal was NOT reversed, so it stays pinned in the test right
  // below — only the finance half inverts.
  it("renders the restored finance destination in the platform navigation", () => {
    expect(mainItems.map(({ domain }) => domain)).toContain("finance");
    expect(mainItems.map(({ label }) => label)).toContain("账务与退款");
    expect(navigationGroups.flatMap(({ items }) => [...items])).toContain("finance");
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
    // No `visibleDomains` here, so this is the unfiltered navigation.
    expect(markup).toContain("账务与退款");
    // Records the owner's group-label choice. Note this is a data assertion,
    // not a visual one: `OpsSidebar` renders no heading for a navigation group
    // (it maps `group.items` and uses `group.label` nowhere), so renaming the
    // group changes nothing an operator sees. Asserting it here keeps the
    // decision written down rather than letting it drift.
    expect(navigationGroups.find(({ key }) => key === "model-billing")?.label).toBe("财务");
    expect(markup).not.toContain("模型与计费");
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
    expect(markup).not.toContain("平台治理");
    expect(markup).not.toContain("模型与计费");
    expect(markup).not.toContain("商家工作区治理");
    expect(markup).not.toContain("风险与系统");
    expect(markup).not.toContain("受控支持入口");
  });
});
