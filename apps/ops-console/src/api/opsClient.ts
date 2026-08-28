import type { OpsRequestError, Rpc } from "../types/ops.js";

export function describeOpsError(error: unknown): string {
  const candidate = error as Partial<OpsRequestError> | undefined;
  const rawMessage = error instanceof Error ? error.message : "";
  if (candidate?.code === "API_REQUEST_TIMEOUT")
    return "运营 API 请求超时。请检查 API、数据库和 SSO 网关状态后重试。";
  if (
    rawMessage === "Failed to fetch" ||
    rawMessage === "NetworkError" ||
    rawMessage === "Load failed"
  ) {
    return "无法连接运营 API，可能是 API 地址、CORS 或网关暂时不可用。请检查部署配置后重试。";
  }
  switch (candidate?.code) {
    case "UNAUTHENTICATED":
    case "SESSION_EXPIRED":
      return "运营登录已失效或尚未登录。请先完成 SSO 登录，再点击“刷新数据”。";
    case "MEMBER_NOT_ACTIVE":
    case "MEMBER_SUSPENDED":
      return "当前运营成员已被停用或尚未激活，请联系工作区管理员恢复权限。";
    case "FORBIDDEN":
      return "当前账号没有访问部分运营数据的权限；请切换具备对应角色的运营账号。";
    case "INTERNAL_ERROR":
      return "运营服务暂时不可用。请先重试；若持续失败，请检查 API、数据库和 SSO 网关状态。";
    case "API_NOT_CONFIGURED":
      return "运营 API 未配置。请设置 VITE_API_BASE 后重新启动运营台；当前页面不会把演示页面误当作 API。";
    case "OPS_WORKSPACE_REQUIRED":
      return "请先输入真实工作区 ID，再读取运营数据。页面不会默认使用演示工作区。";
    case "API_INVALID_RESPONSE":
      return "运营 API 返回了无法识别的响应。请检查 VITE_API_BASE 是否指向 API 网关，而不是前端页面地址。";
    default:
      return error instanceof Error && error.message
        ? error.message
        : "运营数据加载失败，请重试。";
  }
}

// A production bundle must never silently fall back to the local demo operator.
// Development keeps the fixture-friendly local mode; deployed builds require
// the OIDC gateway session unless explicitly configured otherwise.
export const managedOpsSession =
  import.meta.env.PROD || import.meta.env.VITE_OPS_AUTH_MODE === "oidc";
export const OPS_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_OPS_RESPONSE_BYTES = 4 * 1024 * 1024;

export function opsApiBase(): string {
  return (
    localStorage.getItem("ops_api_base")?.trim() ||
    String(import.meta.env.VITE_API_BASE ?? "").trim()
  );
}

/**
 * The console must never manufacture a workspace or operator identity. In
 * local development the token is intentionally entered by the operator and
 * kept only in browser storage; production uses the OIDC gateway session.
 */
export function hasOpsCredentials(): boolean {
  return (
    managedOpsSession ||
    Boolean(localStorage.getItem("ops_api_token")?.trim())
  );
}

export function hasOpsConnection(): boolean {
  const storage = managedOpsSession ? sessionStorage : localStorage;
  return (
    hasOpsCredentials() && Boolean(storage.getItem("ops_workspace_id")?.trim())
  );
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error("运营 API 响应超过安全大小限制");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error("运营 API 响应超过安全大小限制");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("运营 API 响应超过安全大小限制");
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

async function rpcAtWorkspace(
  workspaceOverride: string | undefined,
  method: string,
  params: Record<string, string> = {},
): Promise<Rpc["result"]> {
  const apiBase = opsApiBase();
  if (!apiBase) {
    const error = new Error("运营 API 未配置") as OpsRequestError;
    error.code = "API_NOT_CONFIGURED";
    throw error;
  }
  const workspaceId = workspaceOverride ??
    ((managedOpsSession
      ? sessionStorage.getItem("ops_workspace_id")
      : localStorage.getItem("ops_workspace_id")) ?? "").trim();
  if (!workspaceId) {
    const error = new Error("请先配置真实工作区 ID") as OpsRequestError;
    error.code = "OPS_WORKSPACE_REQUIRED";
    throw error;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-workspace-id": workspaceId,
  };
  if (!managedOpsSession) {
    headers["x-actor-id"] =
      localStorage.getItem("ops_actor_id") ?? "";
    const token = localStorage.getItem("ops_api_token")?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    OPS_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${apiBase}/mcp`, {
      method: "POST",
      credentials: managedOpsSession ? "include" : "same-origin",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
      signal: controller.signal,
    });
    const raw = await readBoundedResponseText(response, MAX_OPS_RESPONSE_BYTES);
    let body: Rpc;
    try {
      body = JSON.parse(raw) as Rpc;
    } catch {
      const error = new Error(
        `运营 API 返回非 JSON（HTTP ${response.status}）`,
      ) as OpsRequestError;
      error.code = "API_INVALID_RESPONSE";
      error.httpStatus = response.status;
      throw error;
    }
    const envelopeError = body.error ?? body.data?.error;
    if (!response.ok || envelopeError) {
      const error = new Error(
        envelopeError?.message ?? `运营接口请求失败（HTTP ${response.status}）`,
      ) as OpsRequestError;
      error.code = envelopeError?.code;
      error.httpStatus = response.status;
      throw error;
    }
    return body.data?.result ?? body.result;
  } catch (cause) {
    if (controller.signal.aborted) {
      const error = new Error("运营 API 请求超时") as OpsRequestError;
      error.code = "API_REQUEST_TIMEOUT";
      throw error;
    }
    throw cause;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function rpc(
  method: string,
  params: Record<string, string> = {},
): Promise<Rpc["result"]> {
  return rpcAtWorkspace(undefined, method, params);
}

export async function rpcForWorkspace(
  workspaceId: string,
  method: string,
  params: Record<string, string> = {},
): Promise<Rpc["result"]> {
  return rpcAtWorkspace(workspaceId, method, { workspace_id: workspaceId, ...params });
}
