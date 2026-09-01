import { describe, expect, it } from "vitest";
import { isLazyChunkError, OpsPageBoundary, pageBoundaryRecoveryLabel } from "./OpsPageBoundary.js";
import { renderToStaticMarkup } from "react-dom/server";

describe("OpsPageBoundary lazy chunk recovery", () => {
  it("recognizes deployment and network chunk failures that require a real reload", () => {
    expect(isLazyChunkError(new TypeError("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isLazyChunkError(new Error("Loading chunk 42 failed"))).toBe(true);
    expect(isLazyChunkError(new Error("Failed to fetch module script"))).toBe(true);
  });

  it("keeps ordinary render errors on the local retry path", () => {
    expect(isLazyChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
  });

  it("renders a focusable, assertive desktop recovery summary with a 44px action", () => {
    const boundary = new OpsPageBoundary({ children: null, resetKey: "users" });
    boundary.state = { error: new Error("Cannot read properties of undefined") };
    const markup = renderToStaticMarkup(boundary.render());

    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('data-focus-target="error-summary"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('aria-label="重试页面"');
    expect(markup).toContain('style="min-height:44px"');
  });

  it("uses a reload label for a stale lazy chunk", () => {
    expect(pageBoundaryRecoveryLabel(true)).toBe("重新加载控制台");
    expect(pageBoundaryRecoveryLabel(false)).toBe("重试页面");
  });
});
