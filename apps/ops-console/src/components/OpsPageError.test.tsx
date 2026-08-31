import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsPageError } from "./OpsPageError.js";
import { presentOpsError } from "./opsErrorPresentation.js";

describe("OpsPageError", () => {
  it("exposes an assertive error and an accessible retry action", () => {
    const markup = renderToStaticMarkup(<OpsPageError error="运营 API 请求超时" onRetry={() => undefined} />);
    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('aria-label="重试加载运营数据"');
    expect(markup).toContain("运营 API 请求超时");
  });

  it("renders nothing when there is no error", () => {
    expect(renderToStaticMarkup(<OpsPageError error="" onRetry={() => undefined} />)).toBe("");
  });

  it("turns OIDC configuration internals into a support path without exposing the raw secret name", () => {
    const error = Object.assign(new Error("OIDC_PROXY_SIGNING_SECRET is missing"), {
      code: "OIDC_PROXY_SIGNING_SECRET_MISSING",
      requestId: "req-auth-1",
    });
    const markup = renderToStaticMarkup(<OpsPageError error={error} />);

    expect(markup).toContain("运营环境尚未配置完整");
    expect(markup).toContain("联系支持");
    expect(markup).not.toContain("OIDC_PROXY_SIGNING_SECRET is missing");
    expect(markup).toContain("查看诊断信息");
    expect(markup).toContain("OIDC_PROXY_SIGNING_SECRET_MISSING");
    expect(markup).toContain("req-auth-1");
    expect(markup).not.toContain("<details open");
  });

  it("turns an expired OIDC session into a reauthentication path", () => {
    const error = Object.assign(new Error("gateway session expired"), { code: "SESSION_EXPIRED" });
    const markup = renderToStaticMarkup(<OpsPageError error={error} />);

    expect(markup).toContain("登录状态已失效");
    expect(markup).toContain('aria-label="重新登录运营后台"');
    expect(markup).not.toContain("gateway session expired");
  });

  it("does not send an unavailable OIDC gateway into a re-login loop", () => {
    expect(presentOpsError(Object.assign(new Error("OIDC gateway unavailable"), {
      code: "OIDC_GATEWAY_UNAVAILABLE",
      retryable: true,
    }))).toMatchObject({
      title: "运营服务暂时不可用",
      recovery: "retry",
    });
  });

  it("maps MCP protocol errors to retry and keeps the technical code collapsed", () => {
    const error = Object.assign(new Error("JSON-RPC -32601 Unknown method"), { code: "MCP_METHOD_NOT_FOUND" });
    const markup = renderToStaticMarkup(<OpsPageError error={error} onRetry={() => undefined} />);

    expect(markup).toContain("当前功能暂时不可用");
    expect(markup).toContain('aria-label="重试加载运营数据"');
    expect(markup).not.toContain("Unknown method");
    expect(markup).toContain("MCP_METHOD_NOT_FOUND");
  });

  it("maps environment failures to support instead of leaking environment variables", () => {
    const error = Object.assign(new Error("VITE_API_BASE points to the frontend"), { code: "API_NOT_CONFIGURED" });
    const markup = renderToStaticMarkup(<OpsPageError error={error} onContactSupport={() => undefined} />);

    expect(markup).toContain("运营环境尚未配置完整");
    expect(markup).toContain('aria-label="联系平台支持"');
    expect(markup).not.toContain("VITE_API_BASE");
    expect(markup).toContain("API_NOT_CONFIGURED");
  });

  it("uses retry timing and correlation metadata for transient failures", () => {
    const presentation = presentOpsError(Object.assign(new Error("upstream unavailable"), {
      code: "HTTP_503",
      retryable: true,
      retryAfterSeconds: 7.2,
      traceId: "trace-503",
    }));

    expect(presentation).toMatchObject({
      title: "运营服务暂时不可用",
      recovery: "retry",
      retryAfterSeconds: 8,
      traceId: "trace-503",
    });
    expect(presentation?.description).toContain("8 秒后重试");
  });

  it("maps permission failures to a support path", () => {
    expect(presentOpsError(Object.assign(new Error("forbidden"), { code: "FORBIDDEN" }))).toMatchObject({
      title: "当前账号无权执行此操作",
      recovery: "contact_support",
      code: "FORBIDDEN",
    });
  });

  it("preserves server decision evidence without inventing client correlation IDs", () => {
    const error = Object.assign(new Error("forbidden"), {
      code: "FORBIDDEN",
      requestId: "req-403",
      details: { decision_id: "dec-7", reason_code: "CAPABILITY_DENIED", obligations_missing: ["mfa", "approval"] },
    });
    const presentation = presentOpsError(error);
    expect(presentation).toMatchObject({ requestId: "req-403", decisionId: "dec-7", reasonCode: "CAPABILITY_DENIED", obligationsMissing: ["mfa", "approval"] });
    const markup = renderToStaticMarkup(<OpsPageError error={error} />);
    expect(markup).toContain("决策 ID");
    expect(markup).toContain("dec-7");
    expect(markup).toContain("缺失义务");
    expect(markup).toContain("mfa, approval");
  });
});
