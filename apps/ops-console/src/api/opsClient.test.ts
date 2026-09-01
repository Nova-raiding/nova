import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOpsConnectionConfig,
  abortOpsRequests,
  describeOpsError,
  hasOpsConnection,
  opsRestGetWithMeta,
  purgeLocalOpsCredentialsForManagedSession,
  readOpsConnectionConfig,
  resolveManagedOpsSession,
  rpcForWorkspace,
  rpcWithMeta,
  saveOpsConnectionConfig,
} from "./opsClient.js";
import type { OpsRequestError } from "../types/ops.js";

const storage = () => ({ getItem: (_key: string) => "", setItem: (_key: string, _value: string) => undefined, removeItem: (_key: string) => undefined, clear: () => undefined });

afterEach(() => vi.unstubAllGlobals());

describe("workspace RPC boundary", () => {
  it("forces OIDC for every production bundle while allowing explicit local mode only outside production", () => {
    expect(resolveManagedOpsSession({ PROD: true, VITE_OPS_AUTH_MODE: "local" })).toBe(true);
    expect(resolveManagedOpsSession({ PROD: true, VITE_OPS_AUTH_MODE: "oidc" })).toBe(true);
    expect(resolveManagedOpsSession({ PROD: false, VITE_OPS_AUTH_MODE: "oidc" })).toBe(true);
    expect(resolveManagedOpsSession({ PROD: false, VITE_OPS_AUTH_MODE: "local" })).toBe(false);
  });

  it("removes persisted local bearer credentials when the managed bundle starts", () => {
    const removeItem = vi.fn();

    purgeLocalOpsCredentialsForManagedSession({ removeItem }, true);

    expect(removeItem.mock.calls.map(([key]) => key)).toEqual([
      "ops_connection_config_v1",
      "ops_actor_id",
      "ops_api_token",
    ]);
    expect(removeItem).not.toHaveBeenCalledWith("ops_api_base");
    expect(removeItem).not.toHaveBeenCalledWith("ops_workspace_id");

    removeItem.mockClear();
    purgeLocalOpsCredentialsForManagedSession({ removeItem }, false);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("atomically saves a local connection and reads the same tuple after refresh", async () => {
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
    expect(saved).toEqual({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "actor_demo", token: "pilot-local-token", workbench: "platform" });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readOpsConnectionConfig()).toEqual(saved);
    expect(hasOpsConnection()).toBe(true);

    await rpcWithMeta("ops.session");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/mcp", expect.objectContaining({
      credentials: "same-origin",
      headers: expect.objectContaining({
        authorization: "Bearer pilot-local-token",
        "x-actor-id": "actor_demo",
        "x-workspace-id": "ws_demo",
        "x-ops-workbench": "platform",
      }),
    }));
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

    expect(readOpsConnectionConfig()).toEqual({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "actor_demo", token: "pilot-local-token", workbench: "workspace" });
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
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://ops.test/v1/delivery-readiness", expect.objectContaining({ method: "GET", credentials: "same-origin", headers: expect.objectContaining({ authorization: "Bearer token-rest", "x-actor-id": "actor-rest", "x-workspace-id": "ws-rest", "x-ops-workbench": "workspace" }) }));
    await expect(opsRestGetWithMeta("/v1/delivery-readiness")).resolves.toMatchObject({ state: "empty", data: null });
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
