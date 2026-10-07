import { describe, expect, it } from "vitest";
import { normalizeDiagnosticTokens, opsLoadWarningPresentation, presentOpsError } from "./opsErrorPresentation.js";

describe("ops error presentation", () => {
  it("classifies auth, permission, configuration, MCP, and retryable failures", () => {
    expect(presentOpsError({ code: "SESSION_EXPIRED", message: "expired" })?.recovery).toBe("reauthenticate");
    expect(presentOpsError({ code: "FORBIDDEN", message: "denied" })?.recovery).toBe("contact_support");
    expect(presentOpsError({ code: "OPS_CONFIG_INVALID", message: "bad config" })?.recovery).toBe("contact_support");
    expect(presentOpsError({ code: "MCP_PROTOCOL_ERROR", message: "bad response" })?.recovery).toBe("retry");
    expect(presentOpsError({ code: "HTTP_503", message: "unavailable", retryAfterSeconds: 1.2 })?.description).toContain("2 秒");
  });

  it("bounds and sanitizes server diagnostics without treating them as authorization", () => {
    expect(normalizeDiagnosticTokens([" a ", "a", "", 1, "b"], 2)).toEqual(["a", "b"]);
    const result = presentOpsError({
      code: "FORBIDDEN",
      message: "denied",
      requestId: " req-1 ",
      details: { obligations_missing: ["read", "read", "write", null] },
    });
    expect(result).toMatchObject({ requestId: "req-1", obligationsMissing: ["read", "write"] });
  });

  it("keeps partial refresh failures distinct from an empty successful dataset", () => {
    expect(opsLoadWarningPresentation("部分数据集刷新失败（用户、任务）")).toEqual({
      summary: "2 个数据集刷新失败，页面已保留上次成功数据。",
      detail: "部分数据集刷新失败（用户、任务）",
    });
    expect(opsLoadWarningPresentation("没有可识别的错误")).toEqual({ summary: "没有可识别的错误", detail: undefined });
  });
});
