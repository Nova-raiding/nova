import { describe, expect, it } from "vitest";
import type { ModelUsageSettlementRecord } from "../../types/ops.js";
import {
  modelUsageSettlementStatus,
  settlementActions,
  summarizeModelUsageSettlements,
} from "./modelUsageSettlement.js";

const record = (
  input: Partial<ModelUsageSettlementRecord>,
): ModelUsageSettlementRecord => ({
  id: "usage-1",
  run_key: null,
  action_id: null,
  modality: "text",
  model: "model-1",
  provider_request_id: "provider-1",
  observed_at: "2026-08-28T00:00:00.000Z",
  settlement_reason: "cost_unavailable",
  ...input,
});

describe("model usage settlement presentation", () => {
  it("uses the explicit settlement status when the API provides it", () => {
    expect(
      modelUsageSettlementStatus(
        record({ settlement_status: "manual_attention" }),
      ),
    ).toBe("manual_attention");
  });

  it("keeps backward compatibility with the current reason-only response", () => {
    expect(modelUsageSettlementStatus(record({}))).toBe("pending_cost");
    expect(
      modelUsageSettlementStatus(
        record({ settlement_reason: "wallet settlement failed" }),
      ),
    ).toBe("pending_wallet");
    expect(
      modelUsageSettlementStatus(
        record({ settlement_reason: "manual_attention required" }),
      ),
    ).toBe("manual_attention");
  });

  it("counts every actionable state separately", () => {
    expect(
      summarizeModelUsageSettlements([
        record({ id: "cost", settlement_status: "pending_cost" }),
        record({ id: "wallet", settlement_status: "pending_wallet" }),
        record({ id: "manual", settlement_status: "manual_attention" }),
      ]),
    ).toEqual({ pending_cost: 1, pending_wallet: 1, manual_attention: 1 });
  });

  it("only exposes decisions explicitly authorized by the API", () => {
    expect(settlementActions(record({ settlement_status: "pending_cost", allowed_decisions: ["waive", "manual_attention"] }))).toEqual({ retry: false, waive: true, manualAttention: true });
    expect(settlementActions(record({ settlement_status: "manual_attention", allowed_decisions: ["retry"] }))).toEqual({ retry: true, waive: false, manualAttention: false });
    expect(settlementActions(record({ settlement_status: "pending_wallet" }))).toEqual({ retry: false, waive: false, manualAttention: false });
  });
});
