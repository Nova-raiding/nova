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
    expect(source).toContain("errorRef.current?.focus({ preventScroll: true })");
    expect(source).not.toContain("setEvents([])");
    expect(source).toContain("style={{ minHeight: 44 }}");
  });
});
