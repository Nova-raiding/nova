import type { OpsRequestError } from "../types/ops.js";

export type OpsRecoveryAction = "retry" | "reauthenticate" | "contact_support";

export interface OpsErrorPresentation {
  title: string;
  description: string;
  recovery: OpsRecoveryAction;
  code?: string;
  requestId?: string;
  traceId?: string;
  decisionId?: string;
  reasonCode?: string;
  obligationsMissing?: string[];
  retryAfterSeconds?: number;
}

const AUTH_CODES = new Set([
  "UNAUTHENTICATED",
  "SESSION_EXPIRED",
  "OIDC_ASSERTION_INVALID",
  "HTTP_401",
]);

const PERMISSION_CODES = new Set([
  "FORBIDDEN",
  "MEMBER_NOT_ACTIVE",
  "MEMBER_SUSPENDED",
  "HTTP_403",
]);

const CONFIG_CODES = new Set([
  "API_NOT_CONFIGURED",
  "OPS_CONFIG_INVALID",
  "OPS_WORKSPACE_REQUIRED",
  "SESSION_HASH_SECRET_MISSING",
  "OPS_CUSTOMER_ACCESS_GRANT_UNAVAILABLE",
  "RELEASE_METADATA_UNAVAILABLE",
]);

const MCP_CODES = new Set([
  "API_INVALID_RESPONSE",
  "MCP_INVALID_REQUEST",
  "MCP_METHOD_NOT_FOUND",
  "MCP_PROTOCOL_ERROR",
  "METHOD_NOT_FOUND",
  "-32600",
  "-32601",
  "-32603",
]);

const RETRYABLE_CODES = new Set([
  "API_REQUEST_TIMEOUT",
  "API_NETWORK_ERROR",
  "INTERNAL_ERROR",
  "HTTP_408",
  "HTTP_425",
  "HTTP_429",
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
]);

const candidate = (error: unknown): Partial<OpsRequestError> =>
  error && typeof error === "object" ? error as Partial<OpsRequestError> : {};

function normalizedCode(error: unknown): string | undefined {
  const structured = candidate(error).code;
  if (typeof structured === "string" && structured.trim()) return structured.trim().toUpperCase();
  if (typeof error !== "string") return undefined;
  const match = error.trim().match(/^(?:\[)?(-?\d{5}|[A-Z][A-Z0-9_]{2,})(?:\]|:)?(?:\s|$)/u);
  return match?.[1]?.toUpperCase();
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  return typeof error === "string" ? error.trim() : "";
}

function isAuthenticationError(code: string | undefined, message: string): boolean {
  return Boolean(
    (code && (AUTH_CODES.has(code) || /^OIDC_(?:ASSERTION|AUTH|SESSION|TOKEN)_/u.test(code))) ||
    /(?:OIDC|SSO).*(?:会话|断言|登录).*(?:无效|失效|过期)|登录.*(?:失效|过期)|会话.*(?:失效|过期)/iu.test(message),
  );
}

function isConfigurationError(code: string | undefined, message: string): boolean {
  return Boolean(
    (code && (CONFIG_CODES.has(code) || /(?:_MISSING|_NOT_CONFIGURED|_CONFIG_INVALID)$/u.test(code))) ||
    /(?:VITE|OPS|MERCHANT|MODEL|SESSION|OIDC)_[A-Z0-9_]*(?:SECRET|KEY|URL|BASE|MODE|HOSTNAME)|环境变量|签名密钥.*(?:缺少|未配置)/u.test(message),
  );
}

function isMcpError(code: string | undefined, message: string): boolean {
  return Boolean(
    (code && (MCP_CODES.has(code) || code.startsWith("MCP_"))) ||
    /MCP|JSON-RPC|Unknown (?:tool|method)|-3260[013]/iu.test(message),
  );
}

function diagnostics(error: unknown, code: string | undefined) {
  const value = candidate(error);
  const details = value.details;
  const decisionId = typeof details?.decision_id === "string" && details.decision_id.trim() ? details.decision_id.trim() : undefined;
  const reasonCode = typeof details?.reason_code === "string" && details.reason_code.trim() ? details.reason_code.trim() : undefined;
  const obligationsMissing = Array.isArray(details?.obligations_missing)
    ? details.obligations_missing.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : undefined;
  return {
    ...(code ? { code } : {}),
    ...(typeof value.requestId === "string" && value.requestId ? { requestId: value.requestId } : {}),
    ...(typeof value.traceId === "string" && value.traceId ? { traceId: value.traceId } : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(obligationsMissing?.length ? { obligationsMissing } : {}),
    ...(typeof value.retryAfterSeconds === "number" && Number.isFinite(value.retryAfterSeconds)
      ? { retryAfterSeconds: Math.max(0, Math.ceil(value.retryAfterSeconds)) }
      : {}),
  };
}

export function presentOpsError(error: unknown): OpsErrorPresentation | undefined {
  const message = rawMessage(error);
  const code = normalizedCode(error);
  if (!message && !code) return undefined;
  const diagnostic = diagnostics(error, code);

  if (isConfigurationError(code, message)) {
    return {
      title: "运营环境尚未配置完整",
      description: "此问题需要平台支持处理。请勿反复提交操作，并在联系支持时提供下方诊断代码。",
      recovery: "contact_support",
      ...diagnostic,
    };
  }
  if (isAuthenticationError(code, message)) {
    return {
      title: "登录状态已失效",
      description: "请重新登录运营后台。登录完成后，系统会继续使用当前工作区。",
      recovery: "reauthenticate",
      ...diagnostic,
    };
  }
  if (code && PERMISSION_CODES.has(code)) {
    return {
      title: "当前账号无权执行此操作",
      description: "请联系工作区管理员确认账号状态和角色；如权限配置正确仍无法访问，请联系平台支持。",
      recovery: "contact_support",
      ...diagnostic,
    };
  }
  if (isMcpError(code, message)) {
    return {
      title: "当前功能暂时不可用",
      description: "运营服务返回了无法识别的结果。请先重试；若仍失败，请联系平台支持。",
      recovery: "retry",
      ...diagnostic,
    };
  }
  if (candidate(error).retryable === true || (code && RETRYABLE_CODES.has(code))) {
    const retryAfter = diagnostic.retryAfterSeconds;
    return {
      title: "运营服务暂时不可用",
      description: retryAfter
        ? `请等待约 ${retryAfter} 秒后重试；若仍失败，请联系平台支持。`
        : "请重试；若仍失败，请联系平台支持。",
      recovery: "retry",
      ...diagnostic,
    };
  }
  if (code) {
    return {
      title: "运营操作未完成",
      description: "请重试；若仍失败，请联系平台支持，并提供下方诊断代码。",
      recovery: "retry",
      ...diagnostic,
    };
  }
  return {
    title: "无法加载运营数据",
    description: message || "运营数据加载失败。请重试；若仍失败，请联系平台支持。",
    recovery: "retry",
    ...diagnostic,
  };
}
