import { describe, expect, it } from "vitest";
import {
  parseAccessBlocks,
  parseCatalog,
  parseCommercialAccessSummary,
  parseLedger,
  parseCommercialTimeline,
  parseCommercialRefunds,
  commercialRefundEvidence,
  refundPolicyApproval,
  provisionableCatalogItems,
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

  it("uses server-priced executable public catalog entries for provisioning", () => {
    const result = parseCatalog({ items: [
      { id: "draft", sku_code: "draft", name: "草稿", type: "monthly", visibility: "public", version: "v1", price_fen: 200000, price_label: "¥2000.00", benefits_summary: "草稿权益", approval_state: "draft", executable: true, unresolved: [] },
      { id: "blocked", sku_code: "blocked", name: "阻断", type: "monthly", visibility: "public", version: "v1", price_fen: 200000, price_label: "¥2000.00", benefits_summary: "待补充条款", approval_state: "approved", executable: true, unresolved: ["ORDER_TERMS_REQUIRED"] },
      { id: "private", sku_code: "private", name: "私测", type: "trial", visibility: "private", version: "v1", price_fen: 199900, price_label: "¥1999.00", benefits_summary: "私测权益", approval_state: "approved", executable: true, unresolved: [] },
      { id: "ready", sku_code: "ready", name: "正式", type: "onboarding", visibility: "public", version: "v2", price_fen: 500000, price_label: "¥5000.00", benefits_summary: "正式权益", approval_state: "approved", executable: true, unresolved: [] },
      { id: "unpriced", sku_code: "unpriced", name: "定制", type: "monthly", visibility: "public", version: "v1", price_fen: null, price_label: "按合同定价", benefits_summary: "合同定价", approval_state: "approved", executable: true, unresolved: [] },
    ] });

    expect(result.items.find((item) => item.skuCode === "ready")?.priceFen).toBe(500000);
    expect(provisionableCatalogItems(result.items).map((item) => item.skuCode)).toEqual(["ready"]);
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

  it("parses immutable refund events with server status and evidence", () => {
    const result = parseCommercialRefunds({ items: [{
      id: "refund-event-1", workspace_id: "ws_1", order_id: "order_1", request_id: "refund-request-1", revision: 2,
      event_type: "approved", refund_kind: "monthly_unused_points", amount_fen: 2000, points_to_revoke: 10,
      reason: "政策退款", actor_id: "finance-1", evidence: { legal_review_ref: "LAW-1" }, external_refund_id: null,
      created_at: "2026-09-21T00:00:00.000Z",
    }] });
    expect(result).toMatchObject({ total: 1, items: [{ requestId: "refund-request-1", eventType: "approved", amountFen: 2000, pointsToRevoke: 10, evidence: { legal_review_ref: "LAW-1" } }] });
    expect(() => parseCommercialRefunds({ items: [{ ...result.items[0], refund_kind: "made_up" }] })).toThrow("refund_kind 无效");
  });
});
