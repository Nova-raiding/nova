import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StorageReconciliationSummary } from "./StorageReconciliationSummary";

describe("StorageReconciliationSummary", () => {
  it("makes the redacted storage destination discoverable from overview", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSummary onOpen={vi.fn()} summary={{ status: "attention_required", lastRunAt: "2026-08-29T10:00:00Z", quota: { usedBytes: 4096, projectedBytes: 4608, reservedBytes: 512 }, counts: { references: 3, inventoryObjects: 4, matched: 2, missing: 1, metadataMismatches: 0, orphans: 1, crossWorkspace: 0, duplicates: 0 } }} />);
    expect(html).toContain("存储与对账");
    expect(html).toContain("查看对账");
    expect(html).toContain("2 项一致性问题");
    expect(html).not.toContain("storageKey");
    expect(html).not.toContain("storageKey");
  });

  it("explains that the status is not available yet", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSummary onOpen={vi.fn()} />);
    expect(html).toContain("尚未接入");
    expect(html).toContain("仅展示 workspace 汇总");
  });
});
