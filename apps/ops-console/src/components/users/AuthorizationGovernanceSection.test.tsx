import { describe, expect, it } from "vitest";
import { describeGrantScope, parseGrantCapabilities, validateJitExpiry } from "./AuthorizationGovernanceSection";
import { readFileSync } from "node:fs";

describe("AuthorizationGovernanceSection", () => {
  const source = readFileSync(new URL("./AuthorizationGovernanceSection.tsx", import.meta.url), "utf8");

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

  it("describes an exact workspace scope without implying cross-tenant access", () => {
    expect(describeGrantScope(" ws_42 ")).toBe("此 JIT 仅覆盖工作区 ws_42，不会自动扩展到其他工作区。");
    expect(describeGrantScope(" ")).toContain("填写目标工作区 ID");
  });

  it("keeps role and JIT recovery keyboard reachable while retaining form input", () => {
    expect(source).toContain('aria-label="分配平台角色"');
    expect(source).toContain('aria-label="签发 JIT 授权"');
    expect(source).toContain('onRetry={() => roleForm.submit()}');
    expect(source).toContain('onRetry={() => grantForm.submit()}');
    expect(source).toContain('role="status"');
    expect(source).toContain("不会自动扩展到其他工作区");
  });
});
