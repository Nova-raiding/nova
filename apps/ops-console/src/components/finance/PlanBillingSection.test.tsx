import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/icons", () => ({ DownloadOutlined: () => createElement("span", null, "download") }));
vi.mock("antd", () => ({
  Button: ({ children, disabled }: any) => createElement("button", { disabled }, children),
  Card: ({ title, extra, children }: any) => createElement("section", null, title, extra, children),
  Space: ({ children }: any) => createElement("div", null, children),
  Tabs: ({ items }: any) => createElement("div", null, items.map((item: any) => createElement("section", { key: item.key }, item.label, item.children))),
  Tag: ({ children }: any) => createElement("span", null, children),
}));
vi.mock("./AddonTable.js", () => ({ AddonTable: () => createElement("div", null, "addon-table") }));
vi.mock("./CouponTable.js", () => ({ CouponTable: () => createElement("div", null, "coupon-table") }));
vi.mock("./ModelMarkupPanel.js", () => ({ ModelMarkupPanel: () => createElement("div", null, "model-markup-panel") }));
vi.mock("./OfferTable.js", () => ({ OfferTable: () => createElement("div", null, "offer-table") }));
vi.mock("./RolloutTable.js", () => ({ RolloutTable: () => createElement("div", null, "rollout-table") }));

import { PlanBillingSection } from "./PlanBillingSection.js";

const model = (overrides: any = {}): any => ({
  canGlobalCommercial: false,
  canModelMarkup: false,
  exportCommercial: vi.fn(),
  ...overrides,
});

describe("PlanBillingSection", () => {
  it("keeps export disabled and hides model billing without the corresponding capability", () => {
    const html = renderToStaticMarkup(<PlanBillingSection model={model()} />);
    expect(html).toContain("套餐、加购与增长规则");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("模型计费");
    expect(html).toContain("套餐目录");
    expect(html).toContain("灰度规则");
  });

  it("shows model billing only when allowed and leaves other catalog tabs available", () => {
    const html = renderToStaticMarkup(<PlanBillingSection model={model({ canGlobalCommercial: true, canModelMarkup: true })} />);
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("模型计费");
    expect(html).toContain("model-markup-panel");
    expect(html).toContain("导出商业配置");
    expect(html).toContain("加购能力");
    expect(html).toContain("优惠券");
  });
});
