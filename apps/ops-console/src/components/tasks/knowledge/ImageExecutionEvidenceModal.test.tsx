import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canReconcileImageExecution, summarizeImageExecutionEvidence } from "./imageExecutionEvidence.js";

const modalSource = readFileSync(new URL("./ImageExecutionEvidenceModal.tsx", import.meta.url), "utf8");

function execution(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job_image_1",
    taskId: "task_image_1",
    productId: "product_1",
    state: "unknown",
    archiveState: "pending",
    eventId: "event_1",
    attempt: 2,
    providerRequestId: "provider_1",
    revision: 7,
    updatedAt: "2026-09-02T01:02:03.000Z",
    alertState: "open",
    lastAction: "等待中转状态确认",
    nextAction: "检查 relay",
    reconciliationStatus: "required",
    ...overrides,
  } as never;
}

describe("image execution evidence modal", () => {
  it("blocks relay 503 and missing evidence with an explicit desktop recovery path", () => {
    const gate = summarizeImageExecutionEvidence(execution({
      httpStatus: 503,
      errorCode: "HTTP_503",
      errorMessage: "No available channel for model gpt-5.6-sol under group VIP",
    }));

    expect(gate.relay503).toBe(true);
    expect(gate.blocked).toBe(true);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("503 Service Unavailable"),
      expect.stringContaining("request evidence"),
      expect.stringContaining("usage evidence"),
      expect.stringContaining("cost evidence"),
    ]));
    expect(gate.recovery).toEqual(expect.arrayContaining([
      expect.stringContaining("SVIP 计费组"),
      expect.stringContaining("导出脱敏证据包"),
      expect.stringContaining("打开人工收口"),
    ]));
  });

  it("treats dedicated request usage and cost payloads as satisfied evidence", () => {
    const gate = summarizeImageExecutionEvidence(execution({
      state: "completed",
      reconciliationStatus: "completed",
      evidence: {
        request: { requestId: "provider_1" },
        usage: { total_tokens: 64 },
        cost: { actual_cny: 0.12 },
      },
    }));

    expect(gate.blocked).toBe(false);
    expect(gate.evidence.find((item) => item.key === "request")).toMatchObject({ present: true, required: true });
    expect(gate.evidence.find((item) => item.key === "usage")).toMatchObject({ present: true, required: true });
    expect(gate.evidence.find((item) => item.key === "cost")).toMatchObject({ present: true, required: true });
    expect(gate.evidence.find((item) => item.key === "error")).toMatchObject({ required: false, detail: "当前未要求 error evidence。" });
  });

  it("limits manual reconciliation to unknown or explicitly required states", () => {
    expect(canReconcileImageExecution(execution())).toBe(true);
    expect(canReconcileImageExecution(execution({ state: "processing", reconciliationStatus: "not_required" }))).toBe(false);
  });

  it("renders a focusable blocking summary and recovery actions in source", () => {
    expect(modalSource).toContain('tabIndex={-1} role="alert" aria-live="assertive"');
    expect(modalSource).toContain("图片执行仍被阻断");
    expect(modalSource).toContain("request / usage / cost / error evidence");
    expect(modalSource).toContain('aria-label="图片执行证据操作"');
    expect(modalSource).toContain('aria-label="打开人工收口"');
    expect(modalSource).toContain('aria-label="导出脱敏证据包"');
  });
});
