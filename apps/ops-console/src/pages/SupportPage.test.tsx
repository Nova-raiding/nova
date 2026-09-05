import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("SupportPage desktop loading and error contract", () => {
  it("focuses the recoverable error summary and exposes stable screen-reader relationships", async () => {
    const source = await readFile(new URL("./SupportPage.tsx", import.meta.url), "utf8");

    expect(source).toContain('import { OpsPageError } from "../components/OpsPageError.js"');
    expect(source).toContain('<OpsPageError error={model.error ?? ""} onRetry={() => void model.reload()} />');
    expect(source).toContain("onRetry={() => void model.reload()}");
  });

  it("keeps the page aligned with the queue's initial-load distinction", async () => {
    const source = await readFile(new URL("../components/support/SupportQueueSection.tsx", import.meta.url), "utf8");

    expect(source).toContain("const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0)");
    expect(source).toContain('aria-busy={model.loading}');
    expect(source).toContain("loading={model.loading}");
  });
});
