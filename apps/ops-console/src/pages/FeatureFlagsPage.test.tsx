import { describe, expect, it } from "vitest";
import { featureFlagPermissionNotice, getFeatureFlagEnvironmentConfig } from "./FeatureFlagsPage";
import { canonicalReadModeWarning } from "../components/feature-flags/FeatureFlagEditor";

describe("FeatureFlagsPage environment configuration", () => {
  it("explains server-projected read-only and partially restricted states", () => {
    expect(featureFlagPermissionNotice(false, false)).toContain("feature_flag.update 或 feature_flag.emergency");
    expect(featureFlagPermissionNotice(false, true)).toContain("feature_flag.update");
    expect(featureFlagPermissionNotice(true, false)).toContain("feature_flag.emergency");
    expect(featureFlagPermissionNotice(true, true)).toBeUndefined();
  });

  it("defaults local builds to the seeded local_demo environment", () => {
    const config = getFeatureFlagEnvironmentConfig(false);
    expect(config.defaultEnvironment).toBe("local_demo");
    expect(config.environments).toContain("local_demo");
  });

  it("keeps managed production sessions on production environments", () => {
    const config = getFeatureFlagEnvironmentConfig(true);
    expect(config.defaultEnvironment).toBe("production");
    expect(config.environments).not.toContain("local_demo");
  });

  it("warns before a canonical read rollout and names the production evidence gate", () => {
    expect(canonicalReadModeWarning({ key: "other.flag", valueText: "canonical_read" })).toBeUndefined();
    expect(canonicalReadModeWarning({ key: "canonical.product.read_mode", environment: "staging", valueText: "canonical_read" })).toContain("一致性报告");
    expect(canonicalReadModeWarning({ key: "canonical.product.read_mode", environment: "production", valueText: "legacy_shadow", targets: [{ overrideText: "canonical_read" }] })).toContain("正式 canonical cutover evidence");
  });
});
