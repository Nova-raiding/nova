import { describe, expect, it } from "vitest";
import {
  parseAccessBlocks,
  parseCatalog,
  parseCommercialAccessSummary,
  parseLedger,
  parseCommercialTimeline,
  commercialRefundEvidence,
  refundPolicyApproval,
} from "./commercialOperationsClient.js";

describe("commercial operations DTO parsers", () => {
  it("preserves an unknown balance instead of manufacturing zero", () => {
    const result = parseCommercialAccessSummary({
      decision_id: "cad_1", workspace_id: "ws_1", balance_state: "unknown",
      available_points: null, reserved_points: null, allowed: false,
      error_code: "CREATIVE_POINTS_UNAVAILABLE", access_revision: null,
    });
    expect(result.availablePoints).toBeNull();
    expect(result.balanceState).toBe("unknown");
    expect(result.errorCode).toBe("CREATIVE_POINTS_UNAVAILABLE");
  });

  it("rejects contradictory balance projections instead of normalizing them", () => {
    expect(() => parseCommercialAccessSummary({
      decision_id: "cad_2", workspace_id: "ws_1", balance_state: "known",
      available_points: null, reserved_points: 0, allowed: false,
    })).toThrow("known 余额必须包含");
    expect(() => parseCommercialAccessSummary({
      decision_id: "cad_3", workspace_id: "ws_1", balance_state: "unknown",
      available_points: 0, reserved_points: null, allowed: false,
    })).toThrow("unknown 余额不能携带确定点数");
  });

  it("rejects malformed success payloads instead of showing an empty state", () => {
    expect(() => parseAccessBlocks({ total: 1 })).toThrow("items 必须是对象数组");
    expect(() => parseLedger({ items: [{ id: "ledger_1" }] })).toThrow("返回无法识别的商业运营数据");
  });

  it("keeps private visibility explicit for the permission boundary", () => {
    const result = parseCatalog({ items: [{
      id: "sku_1", sku_code: "private_test", name: "非公开测试", type: "trial",
      visibility: "private", version: "v1", price_label: "服务端价格",
      benefits_summary: "服务端权益", approval_state: "draft",
    }] });
    expect(result.items[0]?.visibility).toBe("private");
  });

  it("requires correlation and audit-safe fields on timeline events", () => {
    const result = parseCommercialTimeline({ items: [{ id: "model-usage:u1", workspace_id: "ws_1", kind: "model.usage", status: "settled", occurred_at: "2026-09-05T00:00:00Z", operation_id: "op_1", trace_id: "trace_1", request_id: "req_1", actor_id: "worker", reason: "settled", resource_id: "u1", evidence: { cost_cny: 0.1 } }] });
    expect(result.items[0]).toMatchObject({ operationId: "op_1", traceId: "trace_1", requestId: "req_1", actorId: "worker" });
  });

  it("maps every refund kind to the evidence field enforced by the repository", () => {
    expect(commercialRefundEvidence("onboarding_pre_deployment", "")).toEqual({ deployment_status: "not_started" });
    expect(commercialRefundEvidence("monthly_unused_points", " SUP-1 ")).toEqual({ supplement_agreement_ref: "SUP-1" });
    expect(commercialRefundEvidence("point_pack_unused_points", "EXP-1")).toEqual({ expiry_policy_ref: "EXP-1" });
    expect(commercialRefundEvidence("outage_compensation", "INC-1")).toEqual({ incident_id: "INC-1" });
    expect(commercialRefundEvidence("custom_milestone", "MS-1")).toEqual({ milestone_id: "MS-1" });
    expect(() => commercialRefundEvidence("monthly_unused_points", "  ")).toThrow("证据引用不能为空");
  });

  it("requires a concrete legal review reference before refund approval", () => {
    expect(refundPolicyApproval('{"legal_review_ref":"LAW-1"}')).toEqual({ legal_review_ref: "LAW-1" });
    expect(() => refundPolicyApproval('{"legal_review_ref":""}')).toThrow("非空 legal_review_ref");
    expect(() => refundPolicyApproval("not-json")).toThrow("JSON 对象");
  });
});
