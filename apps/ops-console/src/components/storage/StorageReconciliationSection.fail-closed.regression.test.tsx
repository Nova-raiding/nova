import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StorageReconciliationSection } from "./StorageReconciliationSection.js";
import { StorageReconciliationSummary } from "./StorageReconciliationSummary.js";

describe("storage reconciliation fail-closed display regressions", () => {
  it("treats missing freshness as unverified in the page and overview summary", () => {
    const summary = { status: "clean" as const, lastRunAt: "2026-08-29T10:00:00Z" };
    const page = renderToStaticMarkup(<StorageReconciliationSection summary={summary} />);
    const overview = renderToStaticMarkup(<StorageReconciliationSummary summary={summary} onOpen={() => undefined} />);

    expect(page).toContain("状态待确认，未验证");
    expect(page).toContain("新鲜度待确认");
    expect(page).not.toContain(">对账正常<");
    expect(overview).toContain("状态不可验证");
    expect(overview).not.toContain("对账正常");
  });

  it("marks workspace rows with missing freshness or unknown status unverified", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summaries={[
      { workspaceId: "ws-missing-freshness", status: "clean", lastRunAt: "2026-08-29T10:00:00Z" },
      { workspaceId: "ws-unknown-status", status: "future_status" as never, lastRunAt: "2026-08-29T10:00:00Z", freshness: "fresh" },
    ]} />);

    expect(html).toContain("ws-missing-freshness");
    expect(html).toContain("ws-unknown-status");
    expect((html.match(/状态不可验证/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(">正常<");
  });

  it("never labels fixture workspace rows as normal", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection fixtureDataPresent summaries={[
      { workspaceId: "ws-fixture", status: "clean", lastRunAt: "2026-08-29T10:00:00Z", freshness: "fresh" },
    ]} />);

    expect(html).toContain("对象存储状态不可视为真实就绪");
    expect(html).toContain("演示数据，未验证");
    expect(html).not.toContain(">正常<");
  });

  it("fails closed when a summary or workspace row has an unknown runtime run status", () => {
    const summary = { status: "clean" as const, runStatus: "future_state" as never, lastRunAt: "2026-08-29T10:00:00Z", freshness: "fresh" as const };
    const page = renderToStaticMarkup(<StorageReconciliationSection summary={summary} />);
    const overview = renderToStaticMarkup(<StorageReconciliationSummary summary={summary} onOpen={() => undefined} />);
    const workspace = renderToStaticMarkup(<StorageReconciliationSection summaries={[{ ...summary, workspaceId: "ws-unknown-run" }]} />);

    expect(page).toContain("状态待确认，未验证");
    expect(page).not.toContain(">对账正常<");
    expect(overview).toContain("状态不可验证");
    expect(overview).not.toContain("对账正常");
    expect(workspace).toContain("ws-unknown-run");
    expect(workspace).toContain("状态不可验证");
    expect(workspace).not.toContain(">正常<");
  });

  it("requires run status for an otherwise clean API reconciliation report", () => {
    const summary = { status: "clean" as const, lastRunAt: "2026-08-29T10:00:00Z", freshness: "fresh" as const };
    const page = renderToStaticMarkup(<StorageReconciliationSection summary={summary} />);
    const overview = renderToStaticMarkup(<StorageReconciliationSummary summary={summary} onOpen={() => undefined} />);
    const workspace = renderToStaticMarkup(<StorageReconciliationSection summaries={[{ ...summary, workspaceId: "ws-missing-run-status" }]} />);

    expect(page).toContain("状态待确认，未验证");
    expect(page).not.toContain(">对账正常<");
    expect(overview).toContain("状态不可验证");
    expect(workspace).toContain("ws-missing-run-status");
    expect(workspace).toContain("状态不可验证");
    expect(workspace).not.toContain(">正常<");
  });
});
