import type {
  OpsLegacyResult,
  OpsNextAction,
  OpsRequestError,
  OpsWorkbench,
  OpsResponseMeta,
  OpsRpcResponse,
  Rpc,
  RpcErrorPayload,
  RpcWarning,
} from "../types/ops.js";

export function describeOpsError(error: unknown): string {
  const candidate = error as Partial<OpsRequestError> | undefined;
  const rawMessage = error instanceof Error ? error.message : "";
  if (candidate?.code === "API_REQUEST_TIMEOUT")
    return "运营 API 请求超时。请检查 API、数据库和 SSO 网关状态后重试。";
  if (candidate?.code === "API_NETWORK_ERROR")
    return "无法连接运营 API，可能是 API 地址、CORS 或网关暂时不可用。请检查部署配置后重试。";
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
    case "OPS_CONFIG_INVALID":
      return error instanceof Error && error.message
        ? `${error.message}。请修正连接配置后重试。`
        : "运营连接配置无效，请修正后重试。";
    case "API_INVALID_RESPONSE":
      return "运营 API 返回了无法识别的响应。请检查 VITE_API_BASE 是否指向 API 网关，而不是前端页面地址。";
    case "SUPPORT_REPOSITORY_UNAVAILABLE":
      return "客服工单仓储未配置。请检查 API 的 PostgreSQL 运营仓储配置后重试。";
    case "INCIDENT_REPOSITORY_UNAVAILABLE":
      return "事故仓储未配置。请检查 API 的 PostgreSQL 运营仓储配置后重试。";
    case "FEATURE_FLAG_REPOSITORY_UNAVAILABLE":
      return "功能开关仓储未配置。请检查 API 的 PostgreSQL 运营仓储配置后重试。";
    case "CANONICAL_BACKFILL_CONFLICT_RECHECK_FAILED":
      return "当前商品关系仍有冲突，服务端未允许关闭；请先完成明确修复后重新检查。";
    case "CANONICAL_BACKFILL_CONFLICT_REVISION_CONFLICT":
      return "该冲突已被其他运营人员更新，请刷新队列后重试。";
    case "CANONICAL_BACKFILL_CONFLICT_STATE_INVALID":
      return "该冲突当前状态不允许执行此操作，请刷新后确认最新状态。";
    case "CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE":
      return "Canonical 冲突仓储未配置；当前不能把空队列视为无冲突。";
    case "FINANCE_SEARCH_REPOSITORY_UNAVAILABLE":
      return "跨租户财务检索仓储未配置。该能力必须连接 PostgreSQL 运营数据源。";
    case "AUDIT_CENTER_REPOSITORY_UNAVAILABLE":
      return "审计中心仓储未配置。请检查 API 的 PostgreSQL 运营仓储配置后重试。";
    default:
      return error instanceof Error && error.message
        ? error.message
        : "运营数据加载失败，请重试。";
  }
}

// A production bundle must never silently fall back to the local demo operator.
// Development keeps the fixture-friendly local mode; deployed builds require
// the OIDC gateway session unless explicitly configured otherwise.
type OpsAuthEnvironment = Readonly<Record<string, string | boolean | undefined>>;

const viteEnv = (import.meta as ImportMeta & { env: OpsAuthEnvironment }).env;

export function resolveManagedOpsSession(environment: OpsAuthEnvironment): boolean {
  // Production assets must never expose the local Bearer/operator adapter,
  // even when a deployment accidentally injects a local-mode override.
  if (environment.PROD === true) return true;
  if (environment.VITE_OPS_AUTH_MODE === "oidc") return true;
  if (environment.VITE_OPS_AUTH_MODE === "local") return false;
  return false;
}

export const managedOpsSession = resolveManagedOpsSession(viteEnv);
export const OPS_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_OPS_RESPONSE_BYTES = 4 * 1024 * 1024;
export const OPS_EXPORT_TIMEOUT_MS = 30_000;
export const MAX_OPS_EXPORT_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface OpsRpcOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNextAction = (value: unknown): value is OpsNextAction =>
  typeof value === "string" || isObject(value);
const isWarning = (value: unknown): value is RpcWarning =>
  isObject(value) && typeof value.code === "string" &&
  typeof value.message === "string" &&
  (value.details === undefined || isObject(value.details));

const OPS_CONNECTION_CONFIG_KEY = "ops_connection_config_v1";
const OPS_WORKBENCH_KEY = "ops_workbench";

export interface OpsConnectionConfig {
  apiBase: string;
  workspaceId: string;
  actorId: string;
  token: string;
  workbench: OpsWorkbench;
}

export interface OpsConnectionConfigInput {
  apiBase: string;
  workspaceId: string;
  actorId?: string;
  token?: string;
  workbench?: OpsWorkbench;
}

function configStorage(): Storage {
  return managedOpsSession ? sessionStorage : localStorage;
}

function normalizedApiBase(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/u, "") : "";
}

function normalizedWorkbench(value: unknown): OpsWorkbench {
  return value === "platform" ? "platform" : "workspace";
}

function normalizedConnectionConfig(value: unknown): OpsConnectionConfig | undefined {
  if (!isObject(value)) return undefined;
  const apiBase = normalizedApiBase(value.apiBase);
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  const actorId = typeof value.actorId === "string" ? value.actorId.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  const workbench = normalizedWorkbench(value.workbench);
  if (!apiBase || (workbench === "workspace" && !workspaceId) || (!managedOpsSession && !token)) return undefined;
  return { apiBase, workspaceId, actorId: managedOpsSession ? "" : actorId, token: managedOpsSession ? "" : token, workbench };
}

function legacyConnectionConfig(): OpsConnectionConfig {
  const storage = configStorage();
  return {
    apiBase: normalizedApiBase(
      storage.getItem("ops_api_base") ||
      // OpsHeader historically stores this key in localStorage in both modes.
      // Preserve compatibility without making local Bearer credentials
      // available to managed production sessions.
      (managedOpsSession ? localStorage.getItem("ops_api_base") : "") ||
      viteEnv.VITE_API_BASE,
    ),
    workspaceId: storage.getItem("ops_workspace_id")?.trim() ?? "",
    actorId: managedOpsSession ? "" : localStorage.getItem("ops_actor_id")?.trim() ?? "",
    token: managedOpsSession ? "" : localStorage.getItem("ops_api_token")?.trim() ?? "",
    workbench: normalizedWorkbench(storage.getItem(OPS_WORKBENCH_KEY)),
  };
}

export function readOpsConnectionConfig(): OpsConnectionConfig {
  const storage = configStorage();
  const serialized = storage.getItem(OPS_CONNECTION_CONFIG_KEY);
  if (serialized) {
    try {
      const saved = normalizedConnectionConfig(JSON.parse(serialized));
      if (saved) return saved;
    } catch { /* remove corrupt configuration below and recover from legacy keys */ }
    storage.removeItem(OPS_CONNECTION_CONFIG_KEY);
  }
  return legacyConnectionConfig();
}

function invalidConfig(message: string): OpsRequestError {
  const error = new Error(message) as OpsRequestError;
  error.code = "OPS_CONFIG_INVALID";
  error.retryable = false;
  return error;
}

export function saveOpsConnectionConfig(input: OpsConnectionConfigInput): OpsConnectionConfig {
  const config = normalizedConnectionConfig({
    apiBase: input.apiBase,
    workspaceId: input.workspaceId,
    actorId: input.actorId ?? "",
    token: input.token ?? "",
    workbench: input.workbench ?? "workspace",
  });
  if (!config) {
    if (!normalizedApiBase(input.apiBase)) throw invalidConfig("请填写真实运营 API 地址");
    if ((input.workbench ?? "workspace") === "workspace" && !input.workspaceId.trim()) throw invalidConfig("请填写真实工作区 ID");
    throw invalidConfig("本地认证模式必须填写 Bearer token");
  }
  // One storage write is the commit point: validation failures cannot leave a
  // partially updated endpoint/workspace/credential tuple behind.
  configStorage().setItem(OPS_CONNECTION_CONFIG_KEY, JSON.stringify(config));
  return config;
}

export function clearOpsConnectionConfig(): void {
  configStorage().removeItem(OPS_CONNECTION_CONFIG_KEY);
  configStorage().removeItem(OPS_WORKBENCH_KEY);
}

/** Commit the active UI context without treating URL state as authority. */
export function setOpsWorkbenchContext(workbench: OpsWorkbench): OpsConnectionConfig {
  const storage = configStorage();
  storage.setItem(OPS_WORKBENCH_KEY, workbench);
  const config = { ...readOpsConnectionConfig(), workbench };
  if (normalizedConnectionConfig(config))
    storage.setItem(OPS_CONNECTION_CONFIG_KEY, JSON.stringify(config));
  return config;
}

let opsRequestEpoch = 0;
const activeOpsRequests = new Set<AbortController>();

export function abortOpsRequests(reason = "运营工作台已切换"): number {
  opsRequestEpoch += 1;
  for (const controller of activeOpsRequests) controller.abort(reason);
  activeOpsRequests.clear();
  return opsRequestEpoch;
}

function invalidResponse(message: string, httpStatus?: number): OpsRequestError {
  const error = new Error(`运营 API 返回了无法识别的响应：${message}`) as OpsRequestError;
  error.code = "API_INVALID_RESPONSE";
  error.httpStatus = httpStatus;
  error.retryable = false;
  return error;
}

function responseMeta(body: Rpc<unknown>): OpsResponseMeta {
  if (body.warnings !== undefined &&
      (!Array.isArray(body.warnings) || !body.warnings.every(isWarning)))
    throw invalidResponse("warnings 字段无效");
  if (body.next_actions !== undefined &&
      (!Array.isArray(body.next_actions) || !body.next_actions.every(isNextAction)))
    throw invalidResponse("next_actions 字段无效");
  return {
    ...(typeof body.request_id === "string" ? { requestId: body.request_id } : {}),
    ...(typeof body.trace_id === "string" ? { traceId: body.trace_id } : {}),
    ...(typeof body.workspace_id === "string" ? { workspaceId: body.workspace_id } : {}),
    warnings: body.warnings ?? [],
    nextActions: body.next_actions ?? [],
  };
}

function parseRetryAfter(response: Response, details?: Readonly<Record<string, unknown>>): number | undefined {
  const fromDetails = details?.retry_after_seconds;
  if (typeof fromDetails === "number" && Number.isFinite(fromDetails) && fromDetails >= 0)
    return Math.ceil(fromDetails);
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

function requestError(payload: RpcErrorPayload | undefined, response: Response, meta: OpsResponseMeta): OpsRequestError {
  const error = new Error(payload?.message ?? `运营接口请求失败（HTTP ${response.status}）`) as OpsRequestError;
  error.code = payload?.code ?? `HTTP_${response.status}`;
  error.httpStatus = response.status;
  error.requestId = meta.requestId;
  error.traceId = meta.traceId;
  error.workspaceId = meta.workspaceId;
  error.details = payload?.details;
  error.warnings = meta.warnings;
  error.nextActions = meta.nextActions;
  error.retryAfterSeconds = parseRetryAfter(response, payload?.details);
  error.retryable = payload?.retryable ?? (
    payload?.details?.retryable === true ||
    error.retryAfterSeconds !== undefined ||
    [408, 425, 429, 502, 503, 504].includes(response.status)
  );
  return error;
}

export function opsApiBase(): string {
  return readOpsConnectionConfig().apiBase;
}

/**
 * The console must never manufacture a workspace or operator identity. In
 * local development the token is intentionally entered by the operator and
 * kept only in browser storage; production uses the OIDC gateway session.
 */
export function hasOpsCredentials(): boolean {
  return managedOpsSession || Boolean(readOpsConnectionConfig().token);
}

export function hasOpsConnection(): boolean {
  const config = readOpsConnectionConfig();
  return Boolean(config.apiBase && (config.workbench === "platform" || config.workspaceId) && (managedOpsSession || config.token));
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

async function rpcAtWorkspace<T>(
  workspaceOverride: string | undefined,
  method: string,
  params: Record<string, string> = {},
  options: OpsRpcOptions = {},
): Promise<OpsRpcResponse<T>> {
  const apiBase = opsApiBase();
  if (!apiBase) {
    const error = new Error("运营 API 未配置") as OpsRequestError;
    error.code = "API_NOT_CONFIGURED";
    throw error;
  }
  const connection = readOpsConnectionConfig();
  const workspaceId = workspaceOverride ?? connection.workspaceId;
  if (!workspaceId && connection.workbench === "workspace") {
    const error = new Error("请先配置真实工作区 ID") as OpsRequestError;
    error.code = "OPS_WORKSPACE_REQUIRED";
    throw error;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-ops-workbench": connection.workbench,
  };
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  if (!managedOpsSession) {
    if (connection.actorId) headers["x-actor-id"] = connection.actorId;
    if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  }
  const controller = new AbortController();
  const requestEpoch = opsRequestEpoch;
  activeOpsRequests.add(controller);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  const timeout = globalThis.setTimeout(
    () => { timedOut = true; controller.abort(); },
    options.timeoutMs ?? OPS_REQUEST_TIMEOUT_MS,
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
    const raw = await readBoundedResponseText(response, options.maxResponseBytes ?? MAX_OPS_RESPONSE_BYTES);
    if (requestEpoch !== opsRequestEpoch) throw new DOMException("请求上下文已失效", "AbortError");
    let body: Rpc<T>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed)) throw new Error("response is not an object");
      body = parsed as Rpc<T>;
    } catch {
      throw invalidResponse(`非 JSON 对象（HTTP ${response.status}）`, response.status);
    }
    const meta = responseMeta(body);
    const envelopeError = body.error ?? body.data?.error;
    if (!response.ok || envelopeError) {
      throw requestError(envelopeError ?? undefined, response, meta);
    }
    const wrapped = isObject(body.data) && Object.prototype.hasOwnProperty.call(body.data, "result");
    const direct = Object.prototype.hasOwnProperty.call(body, "result");
    if (!wrapped && !direct) throw invalidResponse("成功响应缺少 result", response.status);
    const data = wrapped ? body.data!.result : body.result;
    if (data === undefined) throw invalidResponse("result 不能为 undefined", response.status);
    return data === null ? { state: "empty", data: null, meta } : { state: "data", data, meta };
  } catch (cause) {
    if (timedOut) {
      const error = new Error("运营 API 请求超时") as OpsRequestError;
      error.code = "API_REQUEST_TIMEOUT";
      error.retryable = true;
      throw error;
    }
    if (options.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (cause instanceof Error && cause.message === "运营 API 响应超过安全大小限制") {
      const error = cause as OpsRequestError;
      error.code = "API_RESPONSE_TOO_LARGE";
      error.retryable = false;
      throw error;
    }
    if (cause instanceof TypeError || (cause instanceof Error && ["Failed to fetch", "NetworkError", "Load failed"].includes(cause.message))) {
      const error = new Error(cause.message || "运营 API 网络请求失败") as OpsRequestError;
      error.code = "API_NETWORK_ERROR";
      error.retryable = true;
      throw error;
    }
    throw cause;
  } finally {
    activeOpsRequests.delete(controller);
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function rpcWithMeta<T = OpsLegacyResult>(
  method: string,
  params: Record<string, string> = {},
  options: OpsRpcOptions = {},
): Promise<OpsRpcResponse<T>> {
  return rpcAtWorkspace<T>(undefined, method, params, options);
}

export async function rpcForWorkspaceWithMeta<T = OpsLegacyResult>(
  workspaceId: string,
  method: string,
  params: Record<string, string> = {},
  options: OpsRpcOptions = {},
): Promise<OpsRpcResponse<T>> {
  // The explicit workspace is the authorization boundary. A caller-supplied
  // wire field must never override it through object spread ordering.
  return rpcAtWorkspace<T>(workspaceId, method, { ...params, workspace_id: workspaceId }, options);
}

export async function rpc<T = OpsLegacyResult>(
  method: string,
  params: Record<string, string> = {},
  options: OpsRpcOptions = {},
): Promise<T | null> {
  return (await rpcWithMeta<T>(method, params, options)).data;
}

export async function rpcForWorkspace<T = OpsLegacyResult>(
  workspaceId: string,
  method: string,
  params: Record<string, string> = {},
  options: OpsRpcOptions = {},
): Promise<T | null> {
  return (await rpcForWorkspaceWithMeta<T>(workspaceId, method, params, options)).data;
}

export async function opsRestGetWithMeta<T>(
  path: string,
  options: OpsRpcOptions = {},
): Promise<OpsRpcResponse<T>> {
  if (!path.startsWith("/v1/") || path.includes("#"))
    throw invalidConfig("运营 REST 路径必须位于 /v1/ 下");
  const apiBase = opsApiBase();
  if (!apiBase) {
    const error = new Error("运营 API 未配置") as OpsRequestError;
    error.code = "API_NOT_CONFIGURED";
    throw error;
  }
  const connection = readOpsConnectionConfig();
  if (!connection.workspaceId && connection.workbench === "workspace") {
    const error = new Error("请先配置真实工作区 ID") as OpsRequestError;
    error.code = "OPS_WORKSPACE_REQUIRED";
    throw error;
  }
  const headers: Record<string, string> = { "x-ops-workbench": connection.workbench };
  if (connection.workspaceId) headers["x-workspace-id"] = connection.workspaceId;
  if (!managedOpsSession) {
    if (connection.actorId) headers["x-actor-id"] = connection.actorId;
    if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  }
  const controller = new AbortController();
  const requestEpoch = opsRequestEpoch;
  activeOpsRequests.add(controller);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? OPS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      method: "GET",
      credentials: managedOpsSession ? "include" : "same-origin",
      headers,
      signal: controller.signal,
    });
    const raw = await readBoundedResponseText(response, options.maxResponseBytes ?? MAX_OPS_RESPONSE_BYTES);
    if (requestEpoch !== opsRequestEpoch) throw new DOMException("请求上下文已失效", "AbortError");
    let body: Rpc<T>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed)) throw new Error("response is not an object");
      body = parsed as Rpc<T>;
    } catch {
      throw invalidResponse(`非 JSON 对象（HTTP ${response.status}）`, response.status);
    }
    const meta = responseMeta(body);
    if (!response.ok || body.error) throw requestError(body.error ?? undefined, response, meta);
    if (!Object.prototype.hasOwnProperty.call(body, "data"))
      throw invalidResponse("成功响应缺少 data", response.status);
    const data = body.data as unknown as T | null;
    if (data === undefined) throw invalidResponse("data 不能为 undefined", response.status);
    return data === null ? { state: "empty", data: null, meta } : { state: "data", data, meta };
  } catch (cause) {
    if (timedOut) {
      const error = new Error("运营 API 请求超时") as OpsRequestError;
      error.code = "API_REQUEST_TIMEOUT";
      error.retryable = true;
      throw error;
    }
    if (options.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (cause instanceof Error && cause.message === "运营 API 响应超过安全大小限制") {
      const error = cause as OpsRequestError;
      error.code = "API_RESPONSE_TOO_LARGE";
      error.retryable = false;
      throw error;
    }
    if (cause instanceof TypeError || (cause instanceof Error && ["Failed to fetch", "NetworkError", "Load failed"].includes(cause.message))) {
      const error = new Error(cause.message || "运营 API 网络请求失败") as OpsRequestError;
      error.code = "API_NETWORK_ERROR";
      error.retryable = true;
      throw error;
    }
    throw cause;
  } finally {
    activeOpsRequests.delete(controller);
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function opsRestGet<T>(path: string, options: OpsRpcOptions = {}): Promise<T | null> {
  return (await opsRestGetWithMeta<T>(path, options)).data;
}

/** POST a workspace-scoped REST command while preserving the same auth,
 * timeout, bounded-response and error envelope rules as the RPC client. */
export async function opsRestPost<T>(path: string, body: Record<string, unknown>, options: OpsRpcOptions = {}): Promise<T | null> {
  if (!path.startsWith("/v1/") || path.includes("#")) throw invalidConfig("运营 REST 路径必须位于 /v1/ 下");
  const apiBase = opsApiBase();
  if (!apiBase) { const error = new Error("运营 API 未配置") as OpsRequestError; error.code = "API_NOT_CONFIGURED"; throw error; }
  const connection = readOpsConnectionConfig();
  if (!connection.workspaceId && connection.workbench === "workspace") { const error = new Error("请先配置真实工作区 ID") as OpsRequestError; error.code = "OPS_WORKSPACE_REQUIRED"; throw error; }
  const headers: Record<string, string> = { "content-type": "application/json", "x-ops-workbench": connection.workbench };
  if (connection.workspaceId) headers["x-workspace-id"] = connection.workspaceId;
  if (!managedOpsSession) { if (connection.actorId) headers["x-actor-id"] = connection.actorId; if (connection.token) headers.authorization = `Bearer ${connection.token}`; }
  const controller = new AbortController(); const requestEpoch = opsRequestEpoch; activeOpsRequests.add(controller);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller(); else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false; const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? OPS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase}${path}`, { method: "POST", credentials: managedOpsSession ? "include" : "same-origin", headers, body: JSON.stringify(body), signal: controller.signal });
    const raw = await readBoundedResponseText(response, options.maxResponseBytes ?? MAX_OPS_RESPONSE_BYTES);
    if (requestEpoch !== opsRequestEpoch) throw new DOMException("请求上下文已失效", "AbortError");
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw invalidResponse(`非 JSON 对象（HTTP ${response.status}）`, response.status); }
    if (!isObject(parsed)) throw invalidResponse(`非 JSON 对象（HTTP ${response.status}）`, response.status);
    const meta = responseMeta(parsed as Rpc<T>); const envelopeError = (parsed as Rpc<T>).error;
    if (!response.ok || envelopeError) throw requestError(envelopeError ?? undefined, response, meta);
    if (!Object.prototype.hasOwnProperty.call(parsed, "data")) throw invalidResponse("成功响应缺少 data", response.status);
    return (parsed.data as T | null | undefined) ?? null;
  } catch (cause) {
    if (timedOut) { const error = new Error("运营 API 请求超时") as OpsRequestError; error.code = "API_REQUEST_TIMEOUT"; error.retryable = true; throw error; }
    if (options.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (cause instanceof TypeError || (cause instanceof Error && ["Failed to fetch", "NetworkError", "Load failed"].includes(cause.message))) { const error = new Error(cause.message || "运营 API 网络请求失败") as OpsRequestError; error.code = "API_NETWORK_ERROR"; error.retryable = true; throw error; }
    throw cause;
  } finally { activeOpsRequests.delete(controller); globalThis.clearTimeout(timeout); options.signal?.removeEventListener("abort", abortFromCaller); }
}
