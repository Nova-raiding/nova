import { describe, expect, it } from "vitest";
import { parseGrantCapabilities, validateJitExpiry } from "./AuthorizationGovernanceSection";

describe("AuthorizationGovernanceSection", () => {
  it("normalizes the comma-separated JIT capability input", () => {
    expect(parseGrantCapabilities(" support.ticket.read, ,catalog.image.retry\n")).toEqual([
      "support.ticket.read",
      "catalog.image.retry",
    ]);
  });

  it("does not manufacture a capability when the input is empty", () => {
    expect(parseGrantCapabilities(undefined)).toEqual([]);
  });

  it("keeps JIT expiry inside the mode-specific local TTL", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    expect(validateJitExpiry("2026-09-01T00:10:00.000Z", "read", now)).toBeUndefined();
    expect(validateJitExpiry("2026-09-01T00:06:00.000Z", "write", now)).toContain("最长 5 分钟");
    expect(validateJitExpiry("2026-09-01T00:16:00.000Z", "read", now)).toContain("最长 15 分钟");
  });

  it("rejects invalid and already expired JIT expiry values", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    expect(validateJitExpiry("not-a-date", "read", now)).toContain("有效的 ISO");
    expect(validateJitExpiry("2026-08-31T23:59:59.000Z", "read", now)).toContain("晚于当前时间");
  });
});
