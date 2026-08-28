import { describe, expect, it } from "vitest";
import { modelCostReadiness, modelReadinessRows } from "./modelReadiness.js";

describe("model readiness presentation", () => {
  it("does not treat a configured provider as final readiness", () => {
    const rows = modelReadinessRows({
      model_readiness: {
        text: {
          provider_configured: true,
          ready: false,
          reasons: ["SVIP 计费组未启用"],
        },
      },
    });

    expect(rows.find((row) => row.key === "text")).toMatchObject({
      providerConfigured: true,
      ready: false,
      reasons: ["SVIP 计费组未启用"],
    });
  });

  it("surfaces cost and billing-group blockers", () => {
    expect(
      modelCostReadiness({
        cost_control_ready: false,
        cost_evidence_ready: false,
        next_actions: [
          "验证价格快照和实际计费分组",
          "完成平台数据处理条款审批",
        ],
      }),
    ).toEqual({
      ready: false,
      blockers: ["验证价格快照和实际计费分组"],
    });
  });
});
