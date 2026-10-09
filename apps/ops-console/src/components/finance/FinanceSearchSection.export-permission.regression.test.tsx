import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FinanceSearchController } from "../../hooks/useFinanceSearch.js";
import { FinanceSearchSection } from "./FinanceSearchSection.js";

const controller: FinanceSearchController = {
  query: { limit: 20 }, records: [], resultsStale: false, loading: false, loadingMore: false,
  detailLoading: false, exporting: false,
  search: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined),
  openDetail: vi.fn(async () => undefined), retryDetail: vi.fn(async () => undefined),
  closeDetail: vi.fn(), downloadCsv: vi.fn(async () => undefined),
};

const render = (canExport: boolean) => renderToStaticMarkup(createElement(FinanceSearchSection, { controller, canExport }));

describe("FinanceSearchSection export capability gate", () => {
  it("keeps finance search available while hiding export without billing.export", () => {
    const html = render(false);
    expect(html).toContain("跨企业主体财务检索");
    expect(html).toContain("检索");
    expect(html).not.toContain("导出当前筛选");
  });

  it("shows export when the caller has billing.export", () => {
    expect(render(true)).toContain("导出当前筛选");
  });

  it("wires platform search and export to their separate server capabilities", () => {
    const source = readFileSync(new URL("../../pages/FinancePage.tsx", import.meta.url), "utf8");
    expect(source).toContain('model.authorization.can("billing.platform.read")');
    expect(source).toContain('model.authorization.can("billing.export")');
    expect(source).toContain("canExport={canExportFinance}");
  });
});
