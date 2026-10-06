import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlatformManualProductImport } from "./PlatformManualProductImport.js";
import type { WorkspaceSummary } from "../../types/ops.js";

const workspaces: WorkspaceSummary[] = [{
  workspaceId: "ws_demo",
  enterpriseName: "贵人鸟",
  status: "active",
  planName: "demo",
  monthlyPriceCny: 0,
  usedTasks: 0,
  includedTasks: 0,
  subscriptionStatus: "active",
  memberCount: 1,
}];

describe("PlatformManualProductImport", () => {
  it("exposes the customer product import entry before a store is selected", () => {
    const markup = renderToStaticMarkup(<PlatformManualProductImport workspaces={workspaces} />);

    expect(markup).toContain("运营代商家上传店铺商品");
    expect(markup).toContain("选择商家工作区");
    expect(markup).toContain("下载模板");
    expect(markup).toContain("上传 Excel / CSV");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("选择已登记的人工店铺");
  });
});
