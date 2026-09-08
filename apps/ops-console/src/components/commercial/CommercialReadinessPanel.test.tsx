import { describe, expect, it } from "vitest";
import { parseCommercialReadiness } from "../../api/commercialOperationsClient.js";
import { evaluateCommercialReadiness } from "./CommercialReadinessPanel.js";

const report = (overrides: Record<string, unknown> = {}) => parseCommercialReadiness({
  schema_version: "commercial.readiness.v1",
  ready: true,
  environment: "non_production",
  message: "报告已返回",
  blockers: [],
  capabilities: {},
  registry: [],
  provider: {},
  creative_points: {},
  ...overrides,
});

describe("CommercialReadinessPanel", () => {
  it("treats missing SKU, commercial policy, registry and settlement evidence as blocked", () => {
    const checks = evaluateCommercialReadiness(report());

    expect(checks.skuChecks).toHaveLength(7);
    expect(checks.skuChecks.every(item => !item.check.ready)).toBe(true);
    expect(checks.policyChecks.every(item => !item.check.ready)).toBe(true);
    expect(checks.registryCheck.ready).toBe(false);
    expect(checks.skuChecks[0].check.reason).toContain("未返回");
  });

  it("does not turn a top-level ready flag into SKU or policy success", () => {
    const checks = evaluateCommercialReadiness(report({ ready: true, message: "错误的上层成功状态" }));

    expect(checks.skuChecks.every(item => !item.check.ready)).toBe(true);
    expect(checks.policyChecks.every(item => !item.check.ready)).toBe(true);
  });

  it("accepts only explicit executable/configured evidence", () => {
    const checks = evaluateCommercialReadiness(report({
      capabilities: {
        onboarding: { executable: true },
        trial: { executable: true },
        monthly_basic: { executable: true },
        monthly_growth: { executable: true },
        monthly_custom: { executable: true },
        points_500: { executable: true },
        points_2000: { executable: true },
        trial_credit: { configured: true },
        point_grant: { configured: true },
        point_expiry: { configured: true },
        refund: { configured: true },
        suspension: { configured: true },
      },
      registry: [{ operation: "catalog.image.generate", enabled: true }],
    }));

    expect(checks.skuChecks.every(item => item.check.ready)).toBe(true);
    expect(checks.policyChecks.every(item => item.check.ready)).toBe(true);
    expect(checks.registryCheck).toMatchObject({ ready: true });
  });

  it("keeps an explicit blocking reason blocked even when a source reports configured", () => {
    const checks = evaluateCommercialReadiness(report({ capabilities: { refund: { configured: true, blocking_reason: "REFUND_POLICY_UNAPPROVED" } } }));

    expect(checks.policyChecks.find(item => item.label === "退款规则")?.check).toMatchObject({ ready: false, reason: "REFUND_POLICY_UNAPPROVED" });
  });
});
