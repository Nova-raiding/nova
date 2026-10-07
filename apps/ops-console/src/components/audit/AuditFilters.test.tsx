import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuditFilters, fromLocalDateTimeValue, toLocalDateTimeValue } from "./AuditFilters.js";

describe("AuditFilters", () => {
  it("round-trips local datetime values and rejects invalid source dates", () => {
    const iso = fromLocalDateTimeValue("2026-10-07T12:34");
    expect(iso).toBe(new Date("2026-10-07T12:34").toISOString());
    expect(toLocalDateTimeValue(iso)).toBe("2026-10-07T12:34");
    expect(toLocalDateTimeValue("not-a-date")).toBe("");
    expect(toLocalDateTimeValue()).toBe("");
  });

  it("renders all accessible filter controls and clears to an empty filter object", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<AuditFilters value={{ text: "query", sources: ["operation"], fromAt: undefined, toAt: undefined }} onChange={onChange} />);
    expect(html).toContain('aria-label="审计记录筛选"');
    expect(html).toContain('aria-label="搜索审计记录"');
    expect(html).toContain('aria-label="按来源筛选"');
    expect(html).toContain('aria-label="审计开始时间"');
    expect(html).toContain("清除筛选");
  });
});
