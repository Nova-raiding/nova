import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("SupportPage desktop loading and error contract", () => {
  it("focuses the recoverable error summary and exposes stable screen-reader relationships", async () => {
    const source = await readFile(new URL("./SupportPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("errorRef.current?.focus({ preventScroll: true })");
    expect(source).toContain('tabIndex={-1} role="alert"');
    expect(source).toContain('aria-live="assertive"');
    expect(source).toContain('aria-atomic="true"');
    expect(source).toContain("aria-labelledby={errorTitleId}");
    expect(source).toContain("aria-describedby={errorDescriptionId}");
    expect(source).toContain('htmlType="button"');
    expect(source).toContain('aria-label="重试客服数据"');
  });

  it("keeps the page aligned with the queue's initial-load distinction", async () => {
    const source = await readFile(new URL("../components/support/SupportQueueSection.tsx", import.meta.url), "utf8");

    expect(source).toContain("const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0)");
    expect(source).toContain('aria-busy={model.loading}');
    expect(source).toContain("loading={model.loading}");
  });
});
