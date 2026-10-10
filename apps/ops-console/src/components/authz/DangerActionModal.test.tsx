import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("DangerActionModal", () => {
  it("keeps the confirmation context and reason recovery contract", async () => {
    const source = await readFile(new URL("./DangerActionModal.tsx", import.meta.url), "utf8");
    expect(source).toContain("objectLabel");
    expect(source).toContain("objectValue");
    expect(source).toContain("scope");
    expect(source).toContain("impact");
    expect(source).toContain("当前 revision");
    expect(source).toContain("reasonLabel");
    expect(source).toContain("disabled={!reason.trim() || loading}");
    expect(source).toContain("aria-describedby={`${reasonId}-hint${error ? ` ${errorId}` : \"\"}`}");
  });

  it("announces failures, prevents duplicate submission and restores focus", async () => {
    const source = await readFile(new URL("./DangerActionModal.tsx", import.meta.url), "utf8");
    expect(source).toContain("triggerRef?.current?.focus({ preventScroll: true })");
    expect(source).toContain("errorRef.current?.focus({ preventScroll: true })");
    expect(source).toContain("afterOpenChange={(visible)");
    expect(source).not.toContain('role="alert" aria-live="assertive"');
    expect(source).toContain('<Alert type="error" showIcon title="操作未完成"');
    expect(source).toContain('aria-busy={loading}');
    expect(source).toContain("onReasonChange(event.target.value)");
  });
});
