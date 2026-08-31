import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanonicalBackfillConflictSection, canSubmitConflictResolution, conflictEvidenceSummary } from "./CanonicalBackfillConflictSection.js";
import type { CanonicalBackfillConflict } from "../../types/ops.js";

describe("CanonicalBackfillConflictSection", () => {
  it("renders an explicit queue empty state in the desktop ops surface", () => {
    const markup = renderToStaticMarkup(<CanonicalBackfillConflictSection enabled />);
    expect(markup).toContain("Canonical 回填人工冲突队列");
    expect(markup).toContain("空结果不代表全量回填已完成");
  });

  it("does not render customer conflict controls when capability is absent", () => {
    expect(renderToStaticMarkup(<CanonicalBackfillConflictSection />)).toBe("");
  });

  it("keeps the conflict queue visible but read-only without update capability", () => {
    const markup = renderToStaticMarkup(<CanonicalBackfillConflictSection enabled canUpdate={false} />);
    expect(markup).toContain("当前为只读权限");
    expect(markup).toContain("不能认领或处理冲突");
    expect(markup).not.toContain(">认领</button>");
    expect(markup).not.toContain(">处理</button>");
  });

  it("exposes a desktop scan entry and explains that scanning is read-only", () => {
    const markup = renderToStaticMarkup(<CanonicalBackfillConflictSection enabled onScan={async () => undefined} />);
    expect(markup).toContain("扫描并刷新队列");
    expect(markup).toContain("刷新队列");
    expect(markup).not.toContain("正在扫描一致性");
  });

  it("requires permission, a real brand scope, evidence confirmation, and a note before submit", () => {
    expect(canSubmitConflictResolution({ canUpdate: false, brandId: "brand-1", evidenceConfirmed: true, note: "已核对" })).toBe(false);
    expect(canSubmitConflictResolution({ canUpdate: true, evidenceConfirmed: true, note: "已核对" })).toBe(false);
    expect(canSubmitConflictResolution({ canUpdate: true, brandId: "brand-1", evidenceConfirmed: false, note: "已核对" })).toBe(false);
    expect(canSubmitConflictResolution({ canUpdate: true, brandId: "brand-1", evidenceConfirmed: true, note: "不" })).toBe(false);
    expect(canSubmitConflictResolution({ canUpdate: true, brandId: "brand-1", evidenceConfirmed: true, note: "已核对证据" })).toBe(true);
  });

  it("keeps the evidence summary tied to the conflict revision", () => {
    const row = { id: "c-1", workspaceId: "ws-1", runId: "run-1", legacyProductId: "legacy-1", code: "AMBIGUOUS", canonicalIds: ["canonical-1"], status: "claimed", revision: 3, createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:00:00Z" } satisfies CanonicalBackfillConflict;
    expect(conflictEvidenceSummary(row)).toEqual({ legacyProductId: "legacy-1", runId: "run-1", conflictCode: "AMBIGUOUS", revision: 3, canonicalIds: ["canonical-1"] });
  });
});
