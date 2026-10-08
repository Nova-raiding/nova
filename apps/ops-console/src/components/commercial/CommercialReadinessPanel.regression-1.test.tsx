import { describe, expect, it } from "vitest";
import { parseCommercialReadiness } from "../../api/commercialOperationsClient.js";
import { commercialReadinessCanEnterProductionGate } from "./CommercialReadinessPanel.js";

describe("CommercialReadinessPanel component regression", () => {
  it("does not advertise production readiness when the report claims ready but required SKU evidence is absent", () => {
    const report = parseCommercialReadiness({
      schema_version: "commercial.readiness.v1",
      ready: true,
      environment: "non_production",
      message: "上游返回 READY",
      blockers: [],
      capabilities: {},
      catalog: {},
      policies: {},
      registry: [],
      provider: {},
      creative_points: {},
    });

    expect(report.ready).toBe(true);
    expect(commercialReadinessCanEnterProductionGate(report)).toBe(false);
  });

  it("keeps the production-gate headline available when every required evidence group is explicit", () => {
    const executable = { executable: true };
    const configured = { configured: true };
    const report = parseCommercialReadiness({
      schema_version: "commercial.readiness.v1",
      ready: true,
      environment: "non_production",
      message: "证据齐全",
      blockers: [],
      capabilities: {
        onboarding: executable, trial: executable, monthly_basic: executable, monthly_growth: executable,
        monthly_custom: executable, points_500: executable, points_2000: executable, image: executable,
      },
      catalog: {},
      policies: { trial_credit: configured, point_grant: configured, point_expiry: configured, refund: configured, suspension: configured },
      registry: [{ operation: "catalog.image.generate", enabled: true }],
      provider: {},
      creative_points: {
        point_balance_repository: true,
        reservation_and_settlement_repository: true,
        auditable: true,
      },
    });

    expect(commercialReadinessCanEnterProductionGate(report)).toBe(true);
  });
});
