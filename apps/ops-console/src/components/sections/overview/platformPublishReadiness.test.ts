import { describe, expect, it } from "vitest";
import { canPublishToProduction } from "./PlatformReadinessSection";
import type { PlatformOperation } from "../../../types/ops";

const readyRow: PlatformOperation = {
  platform: "taobao",
  state: "connected",
  readEnabled: true,
  writeEnabled: true,
  capabilities: [{ capability: "catalog_read", state: "production_canary" }],
  readiness: { ready: true, mediaUpload: { ready: true, configured: true, evidence: true } },
};

describe("production publish readiness", () => {
  it("requires every release gate instead of treating connector readiness as publish readiness", () => {
    expect(canPublishToProduction(readyRow)).toBe(true);
    expect(canPublishToProduction({ ...readyRow, capabilities: [{ capability: "catalog_read", state: "fixture_verified" }] })).toBe(false);
    expect(canPublishToProduction({ ...readyRow, writeEnabled: false })).toBe(false);
    expect(canPublishToProduction({ ...readyRow, state: "fixture_ready" })).toBe(false);
  });
});
