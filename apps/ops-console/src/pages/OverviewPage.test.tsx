import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceDataCoverage } from "./OverviewPage";

describe("WorkspaceDataCoverage", () => {
  it("makes partial durable coverage and invalid snapshots actionable", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceDataCoverage, { metrics: {
      source: "durable_repository", dataCompleteness: "partial", hydration: { invalidSnapshotCount: 8 },
      dataCoverage: { products: 76, tasks: 145, syncJobs: 20, publishJobs: 0, fixtureDataPresent: true },
    } }));
    expect(html).toContain("数据覆盖与完整性");
    expect(html).toContain("无效持久化快照：8");
    expect(html).toContain("当前包含 fixture 数据");
  });

  it("does not render a misleading warning for complete non-fixture coverage", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceDataCoverage, { metrics: {
      source: "durable_repository", dataCompleteness: "complete", hydration: { invalidSnapshotCount: 0 },
      dataCoverage: { products: 1, tasks: 2, syncJobs: 3, publishJobs: 4, fixtureDataPresent: false },
    } }));
    expect(html).toContain("完整");
    expect(html).not.toContain("总览不是完整快照");
    expect(html).not.toContain("当前包含 fixture 数据");
  });
});
