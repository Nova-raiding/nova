import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("FeatureFlagAuditDrawer recovery contract", () => {
  const source = readFileSync(new URL("./FeatureFlagAuditDrawer.tsx", import.meta.url), "utf8");

  it("returns keyboard focus to the audit trigger after the drawer closes", () => {
    expect(source).toContain("returnFocusTo?.isConnected");
    expect(source).toContain("returnFocusTo.focus({ preventScroll: true })");
    expect(source).toContain("afterOpenChange");
  });

  it("focuses an announced error and keeps existing audit context during retry", () => {
    expect(source).toContain('role="alert"');
    expect(source).toContain('aria-live="assertive"');
    expect(source).toContain("errorRef.current?.focus({ preventScroll: true })");
    expect(source).not.toContain("setEvents([])");
    expect(source).toContain("style={{ minHeight: 44 }}");
    expect(source).toContain("已保留最近一次成功加载的审计记录");
    expect(source).toContain("!loading && events.length > 0");
  });

  it("announces loading and empty states without misreporting an errored drawer as empty", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-busy="true"');
    expect(source).toContain("正在加载功能开关审计记录");
    expect(source).toContain("!loading && !error && events.length === 0");
    expect(source).toContain("暂无审计事件");
    expect(source).toContain('aria-label="重新加载审计记录"');
  });
});
