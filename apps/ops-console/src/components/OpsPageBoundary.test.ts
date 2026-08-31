import { describe, expect, it } from "vitest";
import { isLazyChunkError } from "./OpsPageBoundary.js";

describe("OpsPageBoundary lazy chunk recovery", () => {
  it("recognizes deployment and network chunk failures that require a real reload", () => {
    expect(isLazyChunkError(new TypeError("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isLazyChunkError(new Error("Loading chunk 42 failed"))).toBe(true);
    expect(isLazyChunkError(new Error("Failed to fetch module script"))).toBe(true);
  });

  it("keeps ordinary render errors on the local retry path", () => {
    expect(isLazyChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});
