import { describe, expect, it } from "vitest";
import {
  capacityEvidenceLabel,
  capacityEvidenceState,
  productionEvidenceSummary,
} from "./DataReadinessSection";

describe("capacity evidence display", () => {
  it("shows a real ready report as ready", () => {
    expect(capacityEvidenceState({ state: "ready", environment: "preproduction" })).toBe("ready");
    expect(capacityEvidenceLabel("ready")).toBe("已完成");
  });

  it("does not turn an absent or legacy no-load result into evidence pass", () => {
    expect(capacityEvidenceState({ state: "not_required" })).toBe("not_performed");
    expect(capacityEvidenceLabel("not_performed")).toBe("本次未压测");
  });

  it("keeps invalid or explicitly blocked capacity fail-closed", () => {
    expect(capacityEvidenceState({ state: "blocked", reasons: ["missing"] })).toBe("blocked");
    expect(capacityEvidenceLabel("blocked")).toBe("阻断");
  });

  it("does not hide a capability block behind an unperformed capacity run", () => {
    expect(productionEvidenceSummary({ state: "blocked", reasons: ["missing"] }, "not_performed"))
      .toEqual({ color: "red", label: "未通过门禁", ready: false });
  });

  it("accepts the API's explicit not_performed state without treating it as pass", () => {
    expect(capacityEvidenceState({ state: "not_performed" })).toBe("not_performed");
    expect(productionEvidenceSummary({ state: "ready" }, "not_performed").ready).toBe(false);
  });
});
