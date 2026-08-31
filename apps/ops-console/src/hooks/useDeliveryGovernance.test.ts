import { describe, expect, it } from "vitest";
import { DeliveryGovernanceRequestGate } from "./useDeliveryGovernance.js";

describe("delivery governance request gate", () => {
  it("prevents stale delivery evidence from replacing a newer refresh", () => {
    const gate = new DeliveryGovernanceRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });
});
