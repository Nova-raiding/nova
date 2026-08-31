import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mainItems, OpsSidebar } from "./OpsSidebar.js";

describe("OpsSidebar navigation", () => {
  it("uses platform-operations wording for merchant store management", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "stores",
      label: "平台连接",
    });
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
    expect(markup).toContain("大麦运营中心");
    expect(markup).toContain("平台治理");
    expect(markup).toContain("商家运营");
    expect(markup).toContain("模型与计费");
    expect(markup).toContain("风险与系统");
    expect(markup).toContain("当前操作范围");
    expect(markup).toContain("平台级");
    expect(markup).toContain("正在查看平台聚合与控制面数据");
    expect(markup).toContain("未进入工作区");
    expect(markup).toContain("全平台");
    expect(markup).toContain("受控支持入口");
    expect(markup).not.toContain("租户作用域");
    expect(markup).not.toContain("全部平台连接");
    expect(markup).not.toContain("京东一店");
    expect(markup).not.toContain("我的店铺");
    expect(markup).not.toContain("大麦商家中心");
  });

  it("exposes the independent model services destination", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "models",
      label: "模型服务",
    });
  });

  it("exposes member governance as an independent destination", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "members",
      label: "成员与权限",
    });
  });

  it("exposes platform rules and audit as first-class operations destinations", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toEqual(
      expect.arrayContaining([
        { domain: "rules", label: "平台规则" },
        { domain: "audit", label: "审计中心" },
      ]),
    );
  });

  it("exposes support, incidents and feature flags as first-class destinations", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toEqual(
      expect.arrayContaining([
        { domain: "support", label: "客服与 CRM" },
        { domain: "incidents", label: "事故中心" },
        { domain: "feature-flags", label: "功能开关" },
      ]),
    );
  });

  it("omits destinations outside the supplied role-aware visibility set", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="overview"
        stores={[]}
        platformLabels={{}}
        selectedStoreScope=""
        visibleDomains={["overview", "support", "incidents", "audit"]}
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
      />,
    );
    expect(markup).toContain("客服与 CRM");
    expect(markup).toContain("事故中心");
    expect(markup).not.toContain("账务与退款");
    expect(markup).not.toContain("功能开关");
  });

  it("does not render customer store scope in the platform operations navigation", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar activeDomain="stores" stores={[{ platform: "jd", accountId: "store-1", label: "京东一店", state: "connected" }, { platform: "jd", accountId: "store-2", label: "京东二店", state: "refresh_required" }]} platformLabels={{ jd: "京东" }} selectedStoreScope="jd:store-1" onNavigate={() => undefined} onSelectStore={() => undefined} />,
    );
    expect(markup).toContain("受控支持入口");
    expect(markup).not.toContain("京东一店");
    expect(markup).not.toContain("京东二店");
    expect(markup).toContain('aria-label="关闭运营导航"');
  });

  it("shows the authoritative workspace scope instead of claiming full-platform access", () => {
    const markup = renderToStaticMarkup(
      <OpsSidebar
        activeDomain="finance"
        stores={[]}
        platformLabels={{}}
        selectedStoreScope=""
        workspaceId="workspace_ops"
        scope={{ kind: "workspace", id: "workspace_ops" }}
        visibleDomains={["overview", "finance"]}
        onNavigate={() => undefined}
        onSelectStore={() => undefined}
      />,
    );
    expect(markup).not.toContain("全平台");
    expect(markup).toContain("workspace_ops");
    expect(markup).toContain("工作区范围");
    expect(markup).toContain("数据与操作仅限当前工作区");
    expect(markup).toContain("平台治理");
    expect(markup).toContain("模型与计费");
    expect(markup).not.toContain("商家运营");
    expect(markup).not.toContain("风险与系统");
    expect(markup).not.toContain("受控支持入口");
  });
});
