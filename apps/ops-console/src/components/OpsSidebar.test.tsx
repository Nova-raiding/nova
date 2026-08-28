import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mainItems, OpsSidebar } from "./OpsSidebar.js";

describe("OpsSidebar navigation", () => {
  it("uses platform-operations wording for merchant store management", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "stores",
      label: "商家与店铺",
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
    expect(markup).toContain("租户店铺");
    expect(markup).toContain("全部租户店铺");
    expect(markup).not.toContain("我的店铺");
    expect(markup).not.toContain("大麦商家中心");
  });

  it("exposes the independent model services destination", () => {
    expect(mainItems.map(({ domain, label }) => ({ domain, label }))).toContainEqual({
      domain: "models",
      label: "模型服务",
    });
  });
});
