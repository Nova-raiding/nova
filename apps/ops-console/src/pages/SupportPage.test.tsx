import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("SupportPage desktop loading and error contract", () => {
  it("keeps queue errors in one focused recovery surface", async () => {
    const source = await readFile(new URL("./SupportPage.tsx", import.meta.url), "utf8");
    const queue = await readFile(new URL("../components/support/SupportQueueSection.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("OpsPageError");
    expect(queue).toContain('title={<span id="support-queue-error-title">工单队列读取失败</span>}');
    expect(queue).toContain('aria-label="刷新工单"');
  });

  it("keeps the page aligned with the queue's initial-load distinction", async () => {
    const source = await readFile(new URL("../components/support/SupportQueueSection.tsx", import.meta.url), "utf8");

    expect(source).toContain("const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0)");
    expect(source).toContain('aria-busy={model.loading}');
    expect(source).toContain("loading={model.loading}");
  });
});
