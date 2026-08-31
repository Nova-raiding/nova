import { describe, expect, it } from "vitest";
import { FeatureFlagsRequestGate, featureFlagListRequest } from "./useFeatureFlags.js";

describe("feature flag request gate", () => {
  it("prevents a stale filter response from replacing the latest page", () => {
    const gate = new FeatureFlagsRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });

  it("preserves local_demo when loading the seeded local environment", () => {
    expect(featureFlagListRequest({ environment: "local_demo" })).toEqual({ environment: "local_demo", limit: 50 });
    expect(featureFlagListRequest({ environment: "local_demo" }, "next-page")).toEqual({ environment: "local_demo", cursor: "next-page", limit: 50 });
  });
});
