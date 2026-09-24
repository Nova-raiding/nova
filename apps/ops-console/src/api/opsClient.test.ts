import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOpsConnectionConfig,
  clearExpiredOpsSession,
  abortOpsRequests,
  describeOpsError,
  hasOpsConnection,
  logoutPlatformOps,
  opsRestGetWithMeta,
  opsRestPost,
  purgeLocalOpsCredentialsForManagedSession,
  readOpsConnectionConfig,
  resolveLocalBearerSession,
  rpcForWorkspace,
  rpcWithMeta,
  saveOpsConnectionConfig,
} from "./opsClient.js";
import type { OpsRequestError } from "../types/ops.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const storage = () => ({ getItem: (_key: string) => "", setItem: (_key: string, _value: string) => undefined, removeItem: (_key: string) => undefined, clear: () => undefined });

afterEach(() => vi.unstubAllGlobals());

describe("workspace RPC boundary", () => {
  it("uses password sessions in production and reserves bearer sessions for explicit local builds", () => {
    expect(resolveLocalBearerSession({ PROD: true, VITE_OPS_AUTH_MODE: "local" })).toBe(false);
    expect(resolveLocalBearerSession({ PROD: true, VITE_OPS_BUILD_MODE: "local", VITE_OPS_AUTH_MODE: "local" })).toBe(true);
    expect(resolveLocalBearerSession({ PROD: true, VITE_OPS_BUILD_MODE: "password", VITE_OPS_AUTH_MODE: "password" })).toBe(false);
    expect(resolveLocalBearerSession({ PROD: true, VITE_OPS_BUILD_MODE: "password", VITE_OPS_AUTH_MODE: "oidc" })).toBe(false);
    expect(resolveLocalBearerSession({ PROD: true, VITE_OPS_AUTH_MODE: "oidc" })).toBe(false);
    expect(resolveLocalBearerSession({ PROD: true })).toBe(false);
    expect(resolveLocalBearerSession({ PROD: false, VITE_OPS_AUTH_MODE: "oidc" })).toBe(false);
    expect(resolveLocalBearerSession({ PROD: false, VITE_OPS_AUTH_MODE: "local" })).toBe(false);
  });

  it("removes persisted local bearer credentials when the managed bundle starts", () => {
    const removeItem = vi.fn();

    purgeLocalOpsCredentialsForManagedSession({ removeItem }, true);

    expect(removeItem.mock.calls.map(([key]) => key)).toEqual([
      "ops_connection_config_v1",
      "ops_api_base",
      "ops_actor_id",
      "ops_api_token",
    ]);

    removeItem.mockClear();
    purgeLocalOpsCredentialsForManagedSession({ removeItem }, false);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("removes stale local bearer credentials when the password cookie bundle starts", () => {
    const removeItem = vi.fn();

    purgeLocalOpsCredentialsForManagedSession({ removeItem }, true);

    expect(removeItem.mock.calls.map(([key]) => key)).toEqual([
      "ops_connection_config_v1",
      "ops_api_base",
      "ops_actor_id",
      "ops_api_token",
    ]);
  });

  it("keeps API/workspace binding but never persists a bearer in password-session mode", async () => {
    const values = new Map<string, string>();
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    const setItem = vi.spyOn(local, "setItem").mockImplementation((key, value) => { values.set(key, value); });
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: { actor_id: "actor_demo" } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const saved = saveOpsConnectionConfig({ apiBase: "http://127.0.0.1:8787/", workspaceId: " ws_demo ", actorId: " actor_demo ", token: " pilot-local-token ", workbench: "platform" });
    expect(saved).toEqual({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "", token: "", workbench: "platform" });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readOpsConnectionConfig()).toEqual(saved);
    expect(hasOpsConnection()).toBe(false);

    await rpcWithMeta("ops.session");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/mcp", expect.objectContaining({
      credentials: "same-origin",
      headers: expect.objectContaining({
        "x-ops-workbench": "platform",
      }),
    }));
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[1].headers).not.toHaveProperty("x-workspace-id");
    await rpcWithMeta("ops.session", {}, { idempotencyKey: "commercial.refund.request:refund-1" });
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:8787/mcp", expect.objectContaining({
      headers: expect.objectContaining({ "idempotency-key": "commercial.refund.request:refund-1" }),
    }));
    await expect(rpcWithMeta("ops.session", {}, { idempotencyKey: "bad\nkey" })).rejects.toThrow("运营幂等键无效");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opens a platform session without inventing or sending a tenant workspace", async () => {
    const values = new Map<string, string>();
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "setItem").mockImplementation((key, value) => { values.set(key, value); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: { workbench: "platform" } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(saveOpsConnectionConfig({ apiBase: "http://127.0.0.1:8787", workspaceId: "", token: "platform-token", workbench: "platform" })).toMatchObject({ workspaceId: "", workbench: "platform" });
    await rpcWithMeta("ops.session");
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-ops-workbench"]).toBe("platform");
    expect(headers).not.toHaveProperty("x-workspace-id");
  });

  it("uses cookie credentials for password-session RPC restores and ignores stale bearer values", async () => {
    const values = new Map<string, string>([
      ["ops_password_session_active", "true"],
      ["ops_api_base", "http://ops.test/"],
      ["ops_workbench", "platform"],
    ]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "setItem").mockImplementation((key, value) => { values.set(key, value); });
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: { actor_id: "actor_demo", roles: [] } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await rpcWithMeta("ops.session");
    expect(fetchMock).toHaveBeenCalledWith("http://ops.test/mcp", expect.objectContaining({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({
        "x-ops-workbench": "platform",
      }),
    }));

    values.set("ops_workbench", "workspace");
    values.set("ops_workspace_id", "ws-demo");
    values.set("ops_password_session_active", "false");
    values.set("ops_api_token", "token-rest");
    const fetchMockWithToken = vi.fn(async () => new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMockWithToken);
    await rpcWithMeta("ops.members.list");
    expect(fetchMockWithToken).toHaveBeenCalledWith("http://ops.test/mcp", expect.objectContaining({
      credentials: "same-origin",
      headers: expect.objectContaining({
        "x-ops-workbench": "workspace",
      }),
    }));
    const [, request] = fetchMockWithToken.mock.calls[0] as unknown as [string, RequestInit];
    expect(request.headers).not.toHaveProperty("authorization");
  });

  it("never attaches a stale local bearer in the password cookie build", async () => {
    const values = new Map<string, string>([
      ["ops_api_base", "http://ops.test/"],
      ["ops_actor_id", "stale-actor"],
      ["ops_api_token", "stale-bearer"],
      ["ops_password_session_active", "true"],
      ["ops_workbench", "platform"],
    ]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: {} } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await rpcWithMeta("ops.session");

    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("x-actor-id");
    expect(calls[0]?.[1]?.credentials).toBe("include");
  });

  it("keeps the previous valid configuration when a replacement is invalid and can clear it", () => {
    const values = new Map<string, string>();
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "setItem").mockImplementation((key, value) => { values.set(key, value); });
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());

    const original = saveOpsConnectionConfig({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", token: "pilot-local-token" });
    expect(() => saveOpsConnectionConfig({ apiBase: "http://new-api.test", workspaceId: "", token: "new-token" })).toThrowError("请填写真实工作区 ID");
    expect(readOpsConnectionConfig()).toEqual(original);
    clearOpsConnectionConfig();
    expect(hasOpsConnection()).toBe(false);
  });

  it("drops the local bearer from localStorage when the operator logs out", async () => {
    // Regression: 退出登录 only POSTed /v1/auth/logout and switched workbench, so
    // the bearer stayed in localStorage and `onRefresh()` still succeeded — on a
    // shared machine the previous operator's credential survived the logout.
    const values = new Map<string, string>([
      ["ops_connection_config_v1", JSON.stringify({ apiBase: "http://ops.test", workspaceId: "", actorId: "actor-ops", token: "platform-token", workbench: "platform" })],
      ["ops_api_base", "http://ops.test"],
      ["ops_actor_id", "actor-ops"],
      ["ops_api_token", "legacy-platform-token"],
    ]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "setItem").mockImplementation((key, value) => { values.set(key, value); });
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: {} } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(readOpsConnectionConfig().token).toBe("");
    expect(hasOpsConnection()).toBe(false);

    await logoutPlatformOps();
    expect(fetchMock).toHaveBeenCalledWith("http://ops.test/v1/auth/logout", expect.objectContaining({ method: "POST" }));

    expect(values.has("ops_api_token")).toBe(false);
    expect(values.has("ops_connection_config_v1")).toBe(false);
    expect(values.has("ops_api_base")).toBe(false);
    expect(values.has("ops_actor_id")).toBe(false);
    expect(readOpsConnectionConfig().token).toBe("");
    expect(hasOpsConnection()).toBe(false);
  });

  it("keeps the password login available after removing a stale local bearer", () => {
    const values = new Map<string, string>([["ops_api_token", "legacy-platform-token"]]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());

    clearOpsConnectionConfig();
    expect(values.has("ops_api_token")).toBe(false);
    expect(readOpsConnectionConfig().token).toBe("");
    expect(hasOpsConnection()).toBe(false);
  });

  it("clears the persisted password-session hint when the server rejects the session", () => {
    const values = new Map<string, string>([
      ["ops_password_session_active", "true"],
      ["ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "ws-expired", workbench: "workspace" })],
      ["ops_workbench", "workspace"],
    ]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());

    clearExpiredOpsSession();

    expect(values.has("ops_password_session_active")).toBe(false);
    expect(values.has("ops_connection_config_v1")).toBe(false);
    expect(values.has("ops_workbench")).toBe(false);
    expect(readOpsConnectionConfig().workspaceId).toBe("");
  });

  it("recovers from corrupt versioned configuration through the legacy local keys", () => {
    const values = new Map<string, string>([
      ["ops_connection_config_v1", "{broken"],
      ["ops_api_base", "http://127.0.0.1:8787/"],
      ["ops_workspace_id", "ws_demo"],
      ["ops_actor_id", "actor_demo"],
      ["ops_api_token", "pilot-local-token"],
    ]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.spyOn(local, "setItem").mockImplementation((key, value) => { values.set(key, value); });
    vi.spyOn(local, "removeItem").mockImplementation((key) => { values.delete(key); });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());

    expect(readOpsConnectionConfig()).toEqual({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "", token: "", workbench: "workspace" });
    expect(values.has("ops_connection_config_v1")).toBe(false);
  });

  it("does not allow params to override the explicit workspace", async () => {
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => key === "ops_api_base" ? "http://ops.test" : key === "ops_api_token" ? "token" : "");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: [] } }), { status: 200 }));
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", fetchMock);

    await rpcForWorkspace("ws-authorized", "ops.members.list", { workspace_id: "ws-attacker" });

    const [, init] = fetchMock.mock.calls[0]!;
    const request = JSON.parse(String(init?.body)) as { params: Record<string, string> };
    expect(request.params.workspace_id).toBe("ws-authorized");
    expect((init?.headers as Record<string, string>)["x-workspace-id"]).toBe("ws-authorized");
  });

  it("preserves real-data and empty response states with correlation metadata", async () => {
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => key === "ops_api_base" ? "http://ops.test" : key === "ops_api_token" ? "token" : key === "ops_workspace_id" ? "ws-1" : "");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "req-1", trace_id: "trace-1", workspace_id: "ws-1", data: { jsonrpc: "2.0", id: "1", result: { items: [] } }, warnings: [{ code: "STALE", message: "snapshot is old" }], next_actions: ["refresh", { method: "ops.refresh" }], error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "req-2", trace_id: "trace-2", workspace_id: "ws-1", data: { jsonrpc: "2.0", id: "2", result: null }, warnings: [], next_actions: [], error: null }), { status: 200 })));

    await expect(rpcWithMeta<{ items: unknown[] }>("ops.test")).resolves.toEqual({
      state: "data",
      data: { items: [] },
      meta: { requestId: "req-1", traceId: "trace-1", workspaceId: "ws-1", warnings: [{ code: "STALE", message: "snapshot is old" }], nextActions: ["refresh", { method: "ops.refresh" }] },
    });
    await expect(rpcWithMeta("ops.empty")).resolves.toMatchObject({ state: "empty", data: null });
  });

  it("uses the authenticated workspace boundary for read-only REST data and preserves null", async () => {
    const values = new Map<string, string>([["ops_connection_config_v1", JSON.stringify({ apiBase: "http://ops.test", workspaceId: "ws-rest", actorId: "actor-rest", token: "token-rest" })]]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "req-rest", workspace_id: "ws-rest", data: { status: "unverified", items: [] }, warnings: [], next_actions: [], error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "req-empty", workspace_id: "ws-rest", data: null, warnings: [], next_actions: [], error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(opsRestGetWithMeta<{ status: string; items: unknown[] }>("/v1/delivery-readiness")).resolves.toMatchObject({ state: "data", data: { status: "unverified", items: [] }, meta: { requestId: "req-rest", workspaceId: "ws-rest" } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://ops.test/v1/delivery-readiness", expect.objectContaining({ method: "GET", credentials: "same-origin", headers: expect.objectContaining({ "x-workspace-id": "ws-rest", "x-ops-workbench": "workspace" }) }));
    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.headers).not.toHaveProperty("x-actor-id");
    await expect(opsRestGetWithMeta("/v1/delivery-readiness")).resolves.toMatchObject({ state: "empty", data: null });
  });

  it("does not leak a stale workspace header into platform REST requests", async () => {
    const values = new Map<string, string>([["ops_connection_config_v1", JSON.stringify({ apiBase: "http://ops.test", workspaceId: "stale-workspace", actorId: "actor-ops", token: "token-ops", workbench: "platform" })]]);
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => values.get(key) ?? "");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ request_id: "req-platform", data: { ok: true }, warnings: [], next_actions: [], error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await opsRestGetWithMeta("/v1/ops/merchant-registration-applications");
    await opsRestPost("/v1/canonical-backfill/conflicts/scan", { reason: "平台复查" });

    for (const [, init] of fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>) {
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-ops-workbench"]).toBe("platform");
      expect(headers).not.toHaveProperty("x-workspace-id");
    }
  });

  it("rejects malformed REST paths and success envelopes", async () => {
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => key === "ops_api_base" ? "http://ops.test" : key === "ops_api_token" ? "token" : key === "ops_workspace_id" ? "ws-1" : "");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ request_id: "req-bad", warnings: [], next_actions: [], error: null }), { status: 200 })));

    await expect(opsRestGetWithMeta("https://attacker.test/v1/data")).rejects.toMatchObject({ code: "OPS_CONFIG_INVALID" });
    await expect(opsRestGetWithMeta("/v1/delivery-readiness")).rejects.toMatchObject({ code: "API_INVALID_RESPONSE" });
  });

  it("preserves fail-closed diagnostics and retry guidance", async () => {
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => key === "ops_api_base" ? "http://ops.test" : key === "ops_api_token" ? "token" : key === "ops_workspace_id" ? "ws-1" : "");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ request_id: "req-fail", trace_id: "trace-fail", workspace_id: "ws-1", data: null, warnings: [], next_actions: ["configure postgres"], error: { code: "AUDIT_CENTER_REPOSITORY_UNAVAILABLE", message: "审计中心仓储未配置", details: { retry_after_seconds: 7, source: "ops" } } }), { status: 503, headers: { "retry-after": "9" } })));

    const error = await rpcWithMeta("ops.audit.list").catch((cause: OpsRequestError) => cause);
    expect(error).toMatchObject({ code: "AUDIT_CENTER_REPOSITORY_UNAVAILABLE", httpStatus: 503, requestId: "req-fail", traceId: "trace-fail", workspaceId: "ws-1", retryable: true, retryAfterSeconds: 7, details: { retry_after_seconds: 7, source: "ops" }, nextActions: ["configure postgres"] });
    expect(describeOpsError(error)).toContain("审计中心仓储未配置");
  });

  it("rejects malformed success envelopes instead of inventing empty data", async () => {
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => key === "ops_api_base" ? "http://ops.test" : key === "ops_api_token" ? "token" : key === "ops_workspace_id" ? "ws-1" : "");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ request_id: "req-bad", data: { jsonrpc: "2.0", id: "1" }, warnings: [], next_actions: [], error: null }), { status: 200 })));

    await expect(rpcWithMeta("ops.bad")).rejects.toMatchObject({ code: "API_INVALID_RESPONSE", retryable: false });
  });

  it("aborts an old workbench request so a late response cannot commit", async () => {
    const local = storage();
    vi.spyOn(local, "getItem").mockImplementation((key) => key === "ops_api_base" ? "http://ops.test" : key === "ops_api_token" ? "token" : key === "ops_workspace_id" ? "ws-1" : "");
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", storage());
    let resolveResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })));

    const pending = rpcWithMeta("ops.audit.list");
    await Promise.resolve();
    abortOpsRequests("switch");
    resolveResponse(new Response(JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: ["stale"] } }), { status: 200 }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
