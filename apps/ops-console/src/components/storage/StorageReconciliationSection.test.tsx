import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StorageReconciliationSection } from "./StorageReconciliationSection.js";

describe("StorageReconciliationSection accessibility states", () => {
  it("paginates workspace reconciliation rows at twenty per page", () => {
    const summaries = Array.from({ length: 21 }, (_, index) => ({ workspaceId: `ws-${index + 1}`, status: "clean" as const, lastRunAt: "2026-08-29T10:00:00Z", freshness: "fresh" as const }));
    const html = renderToStaticMarkup(<StorageReconciliationSection summaries={summaries} />);
    expect((html.match(/role="listitem"/g) ?? []).length).toBe(20);
    expect(html).toContain("1-20 / 21");
  });

  it("shows redacted workspace status without object download fields", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "attention_required", runStatus: "succeeded", freshness: "fresh", lastRunAt: "2026-08-29T10:00:00Z", quota: { usedBytes: 4096, limitBytes: 8192, reservedBytes: 512, projectedBytes: 4608 }, counts: { references: 3, inventoryObjects: 4, matched: 2, missing: 1, metadataMismatches: 0, orphans: 1, crossWorkspace: 0, duplicates: 0 } }} />);
    expect(html).toContain("需要处理");
    expect(html).toContain("缺失 1");
    expect(html).not.toContain("storageKey");
    expect(html).not.toContain("download");
  });

  it("explains the unavailable state", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection />);
    expect(html).toContain("状态不可验证");
    expect(html).toContain("不提供客户素材、对象 key 或下载入口");
  });

  it("does not show a clean report without verifiable freshness as normal", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "clean", runStatus: "succeeded", freshness: "unknown", lastRunAt: "2026-08-29T10:00:00Z" }} />);
    expect(html).toContain("状态不可验证");
    expect(html).not.toContain("对账正常");
    expect(html).toContain("新鲜度待确认");
  });

  it("omits the empty workspace list control but keeps the real unavailable state visible", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "unavailable" }} onRetry={() => undefined} />);
    expect(html).not.toContain("workspace 对账列表（0）");
    expect(html).not.toContain('aria-label="刷新 workspace 对账列表"');
    expect(html).toContain("状态不可验证");
    expect(html).toContain("暂无可验证的对象清单对账结果");
  });

  it("renders failed, expired, and multi-workspace states without object details", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "failed", runStatus: "failed", freshness: "stale", lastRunAt: "2026-08-29T10:00:00Z", errorMessage: "worker timeout" }} summaries={[{ workspaceId: "ws-a", status: "failed", runStatus: "failed", errorMessage: "worker timeout" }, { workspaceId: "ws-b", status: "clean", runStatus: "succeeded", freshness: "expired", lastRunAt: "2026-08-27T10:00:00Z" }, { workspaceId: "ws-c", status: "clean", runStatus: "succeeded", freshness: "stale", lastRunAt: "2026-08-28T10:00:00Z" }]} />);
    expect(html).toContain("对账失败");
    expect(html).toContain("ws-a");
    expect(html).toContain("已过期");
    expect(html).toContain("需刷新");
    expect(html).not.toContain("worker timeout");
    expect(html).not.toContain("storageKey");
  });

  it("does not turn an unknown runtime status into a green ready state", () => {
    const html = renderToStaticMarkup(<StorageReconciliationSection summary={{ status: "future_status" as never, lastRunAt: "2026-08-29T10:00:00Z" }} />);
    expect(html).toContain("状态待确认，未验证");
    expect(html).toContain("不能视为正常");
    expect(html).not.toContain(">对账正常<");
  });

  it("announces loading without discarding the reconciliation region", () => {
    const markup = renderToStaticMarkup(<StorageReconciliationSection loading />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在加载对账结果");
  });

  it("marks retained quota, counts, and workspace rows as an unverified snapshot while refreshing", () => {
    const markup = renderToStaticMarkup(<StorageReconciliationSection loading summary={{ status: "clean", lastRunAt: "2026-08-29T10:00:00Z", quota: { usedBytes: 4096, reservedBytes: 0, projectedBytes: 4096 }, counts: { references: 3, inventoryObjects: 4, matched: 2, missing: 1, metadataMismatches: 0, orphans: 1, crossWorkspace: 0, duplicates: 0 } }} summaries={[{ workspaceId: "ws-old", status: "clean", lastRunAt: "2026-08-29T10:00:00Z", freshness: "fresh" }]} />);
    expect(markup).toContain("正在刷新；以下数据为上次快照");
    expect(markup).toContain("刷新完成前，下面保留的容量、计数和 workspace 状态未经本次复核");
    expect(markup).toContain('data-snapshot-state="stale"');
    expect(markup).toContain("上次快照，未复核");
    expect(markup).toContain("缺失 1");
    expect(markup).toContain("ws-old");
  });

  it("focuses and announces errors with a keyboard-sized retry action", () => {
    const onRetry = vi.fn();
    const markup = renderToStaticMarkup(<StorageReconciliationSection error="对账服务暂时不可用" onRetry={onRetry} />);
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('data-focus-target="error-summary"');
    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain('aria-label="重试加载对账结果"');
    expect(markup).toContain("min-height:44px");
    expect(markup).toContain("对账服务暂时不可用");
  });

  it("labels retained snapshots as unverified after a failed refresh", () => {
    const markup = renderToStaticMarkup(<StorageReconciliationSection error="对账服务暂时不可用" summary={{ status: "clean", lastRunAt: "2026-08-29T10:00:00Z" }} summaries={[{ workspaceId: "ws-a", status: "clean", lastRunAt: "2026-08-29T10:00:00Z" }]} />);
    expect(markup).toContain("以下是上次成功快照，不能视为当前对账结果");
    expect(markup).toContain("上次快照，未复核");
    expect(markup).not.toContain(">正常<");
  });
});
