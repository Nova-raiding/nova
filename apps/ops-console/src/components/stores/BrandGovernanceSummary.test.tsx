import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/icons", () => ({ ApartmentOutlined: () => createElement("span", null, "icon") }));
vi.mock("antd", () => ({
  Card: ({ title, children }: any) => createElement("section", null, title, children),
  Col: ({ children }: any) => createElement("div", null, children),
  Empty: ({ description }: any) => createElement("div", null, description),
  Row: ({ children }: any) => createElement("div", null, children),
  Statistic: ({ title, value }: any) => createElement("div", null, title, value),
  Tag: ({ children }: any) => createElement("span", null, children),
  Typography: { Paragraph: ({ children }: any) => createElement("p", null, children) },
}));

import { BrandGovernanceSummary } from "./BrandGovernanceSummary.js";

describe("BrandGovernanceSummary", () => {
  it("does not claim platform brand data exists when the summary is absent or all zero", () => {
    expect(renderToStaticMarkup(<BrandGovernanceSummary />)).toContain("尚未取得平台品牌聚合数据");
    expect(renderToStaticMarkup(<BrandGovernanceSummary summary={{ brandCount: 0, boundStoreCount: 0, unboundBrandCount: 0, canonicalProductCount: 0, listingCount: 0 } as any} />)).toContain("尚未取得平台品牌聚合数据");
  });

  it("renders only aggregate counts and the platform-level redaction notice", () => {
    const html = renderToStaticMarkup(<BrandGovernanceSummary summary={{ brandCount: 4, boundStoreCount: 3, unboundBrandCount: 1, canonicalProductCount: 8, listingCount: 9 } as any} />);
    expect(html).toContain("平台级脱敏");
    expect(html).toContain("品牌数4");
    expect(html).toContain("已绑定店铺3");
    expect(html).toContain("未绑定品牌1");
    expect(html).toContain("刊登映射9");
    expect(html).toContain("不返回品牌名称、商品标题、内容或令牌");
  });
});
