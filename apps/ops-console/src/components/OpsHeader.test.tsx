import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOpsConnectionConfig, saveOpsConnectionConfig } from "../api/opsClient.js";
import { OpsConfigError, OpsHeader, readOpsConnectionDraft, saveAndRefreshOpsConnection, workspaceFieldAccessibility } from "./OpsHeader.js";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } } satisfies Storage;
}

describe("OpsHeader accessibility", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", storage());
    vi.stubGlobal("sessionStorage", storage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps connection configuration behind an explicit diagnostic disclosure", () => {
    const markup = renderToStaticMarkup(<OpsHeader managedSession={false} sessionLoaded={false} onRefresh={() => undefined} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-state="missing-credentials"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-controls="ops-connection-fields"');
    expect(markup).toContain("连接诊断");
  });

  it("provides an accessible mobile connection settings disclosure", () => {
    const markup = renderToStaticMarkup(<OpsHeader managedSession={false} sessionLoaded={false} onRefresh={() => undefined} />);
    expect(markup).toContain('aria-controls="ops-connection-fields"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("连接诊断");
  });

  it("atomically saves the complete local tuple before refreshing", () => {
    const local = storage();
    const setItem = vi.spyOn(local, "setItem");
    vi.stubGlobal("localStorage", local);
    const onRefresh = vi.fn();
    const saved = saveAndRefreshOpsConnection({
      apiBase: "http://127.0.0.1:8787/",
      workspaceId: " ws_demo ",
      actorId: " actor_demo ",
      token: " pilot-local-token ",
    }, onRefresh);

    expect(saved).toEqual({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "actor_demo", token: "pilot-local-token", workbench: "workspace" });
    expect(readOpsConnectionConfig()).toEqual(saved);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith("ops_connection_config_v1", JSON.stringify(saved));
    for (const legacyKey of ["ops_api_base", "ops_workspace_id", "ops_actor_id", "ops_api_token"]) {
      expect(setItem).not.toHaveBeenCalledWith(legacyKey, expect.any(String));
    }
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("never copies a stored bearer token into the diagnostic form draft", () => {
    saveOpsConnectionConfig({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "actor_demo", token: "stored-secret" });

    expect(readOpsConnectionDraft()).toEqual({
      apiBase: "http://127.0.0.1:8787",
      workspaceId: "ws_demo",
      actorId: "actor_demo",
      token: "",
      workbench: "workspace",
    });
  });

  it("retains the stored bearer token when the diagnostic field is left blank", () => {
    saveOpsConnectionConfig({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "actor_demo", token: "stored-secret" });
    const onRefresh = vi.fn();

    const saved = saveAndRefreshOpsConnection({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", actorId: "actor_demo", token: "" }, onRefresh);

    expect(saved.token).toBe("stored-secret");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps the previous tuple and does not refresh when validation fails", () => {
    const original = saveOpsConnectionConfig({ apiBase: "http://127.0.0.1:8787", workspaceId: "ws_demo", token: "pilot-local-token" });
    const onRefresh = vi.fn();

    expect(() => saveAndRefreshOpsConnection({ apiBase: "http://new.test", workspaceId: "", token: "new-token" }, onRefresh)).toThrowError("请填写真实工作区 ID");
    expect(readOpsConnectionConfig()).toEqual(original);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("renders configuration failures as an assertive, visible alert", () => {
    const markup = renderToStaticMarkup(<OpsConfigError message="请填写真实工作区 ID。请修正连接配置后重试。" />);
    expect(markup).toContain('id="ops-workspace-id-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("请填写真实工作区 ID");
  });

  it("marks an invalid workspace field and associates it with the visible error", () => {
    expect(workspaceFieldAccessibility("请填写真实工作区 ID。请修正连接配置后重试。")).toEqual({
      "aria-invalid": true,
      "aria-describedby": "ops-workspace-id-error",
    });
    expect(workspaceFieldAccessibility()).toEqual({
      "aria-invalid": undefined,
      "aria-describedby": undefined,
    });
  });

  it("does not render Bearer or actor fields for a production OIDC session", () => {
    const markup = renderToStaticMarkup(<OpsHeader managedSession sessionLoaded={false} onRefresh={() => undefined} />);
    expect(markup).not.toContain("运营 API Token");
    expect(markup).not.toContain('name="token"');
    expect(markup).not.toContain("操作员 ID");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("连接诊断");
    expect(markup).toContain("权限未验证");
  });

  it("labels refreshing as an in-progress operation", () => {
    const markup = renderToStaticMarkup(<OpsHeader managedSession sessionLoaded={false} refreshing onRefresh={() => undefined} />);
    expect(markup).toContain("正在刷新");
    expect(markup).toContain('aria-busy="true"');
  });
});
