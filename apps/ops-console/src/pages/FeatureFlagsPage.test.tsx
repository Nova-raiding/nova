import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { featureFlagPermissionNotice, getFeatureFlagEnvironmentConfig } from "./FeatureFlagsPage";
import { canonicalReadModeWarning } from "../components/feature-flags/FeatureFlagEditor";

describe("FeatureFlagsPage environment configuration", () => {
  const source = readFileSync(new URL("./FeatureFlagsPage.tsx", import.meta.url), "utf8");

  it("moves focus to the announced page error and keeps a keyboard retry", () => {
    expect(source).toContain('import { OpsPageError } from "../components/OpsPageError"');
    expect(source).toContain('<OpsPageError error={model.error ?? ""} onRetry={() => void model.load()} />');
  });

  it("does not expose duplicate refresh or create actions during an active request", () => {
    expect(source).toContain("disabled={model.loading || model.loadingMore || model.saving}");
    expect(source).toContain("disabled={initialLoadFailed || model.saving}");
  });

  it("explains server-projected read-only and partially restricted states", () => {
    expect(featureFlagPermissionNotice(false, false)).toContain("feature_flag.update 或 feature_flag.emergency");
    expect(featureFlagPermissionNotice(false, true)).toContain("feature_flag.update");
    expect(featureFlagPermissionNotice(true, false)).toContain("feature_flag.emergency");
    expect(featureFlagPermissionNotice(true, true)).toBeUndefined();
  });

  it("defaults local builds to a real managed environment instead of seeded demo data", () => {
    const config = getFeatureFlagEnvironmentConfig(false);
    expect(config.defaultEnvironment).toBe("development");
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
