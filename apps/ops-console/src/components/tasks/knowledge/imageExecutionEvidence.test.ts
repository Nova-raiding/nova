import { describe, expect, it } from "vitest";
import { canReconcileImageExecution, summarizeImageExecutionEvidence } from "./imageExecutionEvidence.js";

const execution = (overrides: Record<string, unknown> = {}) => ({ state: "completed", ...overrides } as any);

describe("image execution evidence", () => {
  it("blocks incomplete evidence and identifies relay 503 without authorizing a retry", () => {
    const result = summarizeImageExecutionEvidence(execution({ relay: { status: 503 } }));
    expect(result).toMatchObject({ blocked: true, relay503: true, relayStatus: "503 Service Unavailable" });
    expect(result.recovery.some((item) => item.includes("不要在桌面端重复生成"))).toBe(true);
    expect(result.evidence.filter((item) => item.required && !item.present)).toHaveLength(4);
  });

  it("accepts a complete successful evidence chain and only permits reconciliation states", () => {
    const result = summarizeImageExecutionEvidence(execution({
      requestEvidenceRef: "req-1",
      usageEvidenceRef: "usage-1",
      costEvidenceRef: "cost-1",
    }));
    expect(result.blocked).toBe(false);
    expect(result.evidence.every((item) => item.key !== "error" || !item.required)).toBe(true);
    expect(canReconcileImageExecution(execution({ state: "unknown" }))).toBe(true);
    expect(canReconcileImageExecution(execution({ state: "completed" }))).toBe(false);
  });
});
