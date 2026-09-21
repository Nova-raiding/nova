import { describe, expect, it } from "vitest";
import { modelCostReadiness, modelReadinessRows } from "./modelReadiness.js";

describe("model readiness presentation", () => {
  it("keeps missing server status as an empty result", () => {
    expect(modelReadinessRows(undefined)).toEqual([]);
  });

  it("does not treat a configured provider as runtime readiness", () => {
    const rows = modelReadinessRows({
      state: "partial_model_readiness",
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

  it("keeps unknown runtime state blocked even when a modality says ready", () => {
    const rows = modelReadinessRows({ state: "unknown", model_readiness: { text: { ready: true, provider_configured: true } } });
    expect(rows.find((row) => row.key === "text")).toMatchObject({
      providerConfigured: true,
      ready: false,
      reasons: ["平台模型运行状态为 状态待确认，不能据此判定生产上线"],
    });
  });

  it("does not treat modality gates as final readiness when the global cost gate is blocked", () => {
    const rows = modelReadinessRows({ state: "cost_gate_blocked", model_readiness: { text: { ready: true, provider_configured: true } } });
    expect(rows.find((row) => row.key === "text")).toMatchObject({ ready: false });
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
