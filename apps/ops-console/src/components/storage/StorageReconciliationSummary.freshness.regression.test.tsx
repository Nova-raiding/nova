import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StorageReconciliationSummary } from "./StorageReconciliationSummary.js";
import { StorageReconciliationSection } from "./StorageReconciliationSection.js";

describe("StorageReconciliationSummary freshness regression", () => {
  it.each([
    ["stale" as const, "需要刷新"],
    ["expired" as const, "对账已过期"],
  ])("does not mark a %s report as normal", (freshness, label) => {
    const html = renderToStaticMarkup(<StorageReconciliationSummary onOpen={vi.fn()} summary={{ status: "clean", freshness, lastRunAt: "2026-08-29T10:00:00Z" }} />);
    expect(html).toContain(label);
    expect(html).not.toContain("对账正常");
  });

  it("fails closed for an unknown runtime status and failed run status", () => {
    const unknown = renderToStaticMarkup(<StorageReconciliationSummary onOpen={vi.fn()} summary={{ status: "future_status" as never, lastRunAt: "2026-08-29T10:00:00Z" }} />);
    expect(unknown).toContain("状态不可验证");
    expect(unknown).not.toContain("对账正常");

    const failedRun = renderToStaticMarkup(<StorageReconciliationSummary onOpen={vi.fn()} summary={{ status: "clean", runStatus: "failed", lastRunAt: "2026-08-29T10:00:00Z" }} />);
    expect(failedRun).toContain("对账失败");
    expect(failedRun).not.toContain("对账正常");

    const activePage = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "clean", runStatus: "failed", lastRunAt: "2026-08-29T10:00:00Z" }} />);
    expect(activePage).toContain("对账失败");
    expect(activePage).not.toContain("对账正常");

    const workspaceRow = renderToStaticMarkup(<StorageReconciliationSection summaries={[{ workspaceId: "ws-failed", status: "clean", runStatus: "failed", lastRunAt: "2026-08-29T10:00:00Z" }]} />);
    expect(workspaceRow).toContain("失败");
    expect(workspaceRow).not.toContain(">正常<");
  });
});
