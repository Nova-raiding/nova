import { describe, expect, it } from "vitest";
import { activeJitGrantForNow, formatJitRemaining, jitScopeLabel, jitUseBudgetLabel, nextJitExpiryAt } from "./jitGrant.js";

describe("JIT grant helpers", () => {
  it("formats countdowns with ceiling and clamps expired values", () => {
    expect(formatJitRemaining(61_001)).toBe("01:02");
    expect(formatJitRemaining(-1)).toBe("00:00");
  });

  it("selects only a currently valid grant and finds the earliest finite expiry", () => {
    const now = Date.parse("2026-10-07T00:00:00.000Z");
    const grants = [
      { id: "expired", expires_at: "2026-10-06T23:59:59.000Z" },
      { id: "active", expires_at: "2026-10-07T00:05:00.000Z" },
      { id: "unbounded" },
    ];
    expect(activeJitGrantForNow(grants, now)?.id).toBe("active");
    expect(nextJitExpiryAt(grants)).toBe(Date.parse("2026-10-06T23:59:59.000Z"));
    expect(nextJitExpiryAt([{ expires_at: "not-a-date" }, {}])).toBeUndefined();
  });

  it("renders scope and use budget with safe fallbacks", () => {
    const grant = { workspace_id: "ws-1", resource_scope: { type: "store", ids: ["store-a", "store-b"] }, max_uses: 3, use_count: 1 } as any;
    expect(jitScopeLabel(grant)).toBe("store:store-a, store-b");
    expect(jitUseBudgetLabel(grant)).toBe("已使用 1/3 次");
    expect(jitUseBudgetLabel({ workspace_id: "ws-1" } as any)).toBeUndefined();
  });
});
