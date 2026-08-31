import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StorageReconciliationSection } from "./StorageReconciliationSection";

describe("StorageReconciliationSection", () => {
  it("shows redacted workspace status without object download fields", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "attention_required", lastRunAt: "2026-08-29T10:00:00Z", quota: { usedBytes: 4096, limitBytes: 8192, reservedBytes: 512, projectedBytes: 4608 }, counts: { references: 3, inventoryObjects: 4, matched: 2, missing: 1, metadataMismatches: 0, orphans: 1, crossWorkspace: 0, duplicates: 0 } }} />);
    expect(html).toContain("需要处理");
    expect(html).toContain("缺失 1");
    expect(html).not.toContain("storageKey");
    expect(html).not.toContain("download");
  });

  it("explains the unavailable state", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection />);
    expect(html).toContain("未接入对账");
    expect(html).toContain("不提供客户素材、对象 key 或下载入口");
  });

  it("renders failed, expired, and multi-workspace states without object details", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "failed", errorMessage: "worker timeout" }} summaries={[{ workspaceId: "ws-a", status: "failed", errorMessage: "worker timeout" }, { workspaceId: "ws-b", status: "clean", freshness: "expired", lastRunAt: "2026-08-27T10:00:00Z" }, { workspaceId: "ws-c", status: "clean", freshness: "stale", lastRunAt: "2026-08-28T10:00:00Z" }]} />);
    expect(html).toContain("对账失败");
    expect(html).toContain("ws-a");
    expect(html).toContain("已过期");
    expect(html).toContain("需刷新");
    expect(html).not.toContain("worker timeout");
    expect(html).not.toContain("storageKey");
  });
});
