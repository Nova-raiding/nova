import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { App as AntApp } from "antd";
import { OpsAntAppBoundary, accessDeniedEvidence, accessDeniedGrantedCapabilities, accessDeniedReasonCode, domainHydrationPermissions, isExpectedUnauthenticatedSessionError, opsContentLoadingMessage, opsSessionGateState, selectStoreScope } from "./OpsConsoleController.js";
import { opsLoadWarningPresentation } from "../components/opsErrorPresentation.js";
import { openBrandStore } from "./StoresPage.js";
import { createAuthorizationProjection } from "../authz/authorization.js";

describe("domain hydration permissions", () => {
  const authorization = (capabilities: string[]) => createAuthorizationProjection({
    actor_id: "operator-1",
    workspace_id: "platform",
    roles: [],
    workspace_granted: true,
    capabilities,
  }, true);

  it("recomputes rule and knowledge loading gates when refreshed read grants arrive", () => {
    const noGrants = authorization([]);
    const rulesGranted = authorization(["rule.read"]);
    const knowledgeGranted = authorization(["customer.content.read"]);

    expect(domainHydrationPermissions("rules", "platform", noGrants).rules).toBe(false);
    expect(domainHydrationPermissions("rules", "platform", rulesGranted).rules).toBe(true);
    expect(domainHydrationPermissions("knowledge", "workspace", noGrants).knowledge).toBe(false);
    expect(domainHydrationPermissions("knowledge", "workspace", knowledgeGranted).knowledge).toBe(true);
    expect(domainHydrationPermissions("rules", "workspace", rulesGranted).rules).toBe(false);
  });
});

describe("selectStoreScope", () => {
  it("updates the selected store and loads its automation scope", async () => {
    const setSelectedStoreScope = vi.fn();
    const loadAutomationScope = vi.fn(async () => undefined);

    await expect(selectStoreScope(
      { setSelectedStoreScope, loadAutomationScope },
      "douyin:store-2",
    )).resolves.toBeUndefined();
    expect(setSelectedStoreScope).toHaveBeenCalledWith("douyin:store-2");
    expect(loadAutomationScope).toHaveBeenCalledWith("douyin:store-2");
  });
});

describe("Ops Ant Design runtime provider", () => {
  it("provides a callable message error API to model error paths", () => {
    function ErrorPathProbe() {
      const { message } = AntApp.useApp();
      message.error("模拟模型加载失败");
      return createElement("span", null, "error handled");
    }

    expect(() => renderToStaticMarkup(createElement(
      OpsAntAppBoundary,
      null,
      createElement(ErrorPathProbe),
    ))).not.toThrow();
  });

  it("treats an unauthenticated session as a login state instead of a system error", () => {
    expect(isExpectedUnauthenticatedSessionError({ code: "UNAUTHENTICATED" })).toBe(true);
    expect(isExpectedUnauthenticatedSessionError({ code: "SESSION_EXPIRED" })).toBe(true);
    expect(isExpectedUnauthenticatedSessionError({ code: "API_NETWORK_ERROR" })).toBe(false);
  });
});

describe("desktop keyboard navigation", () => {
  it("exposes a visible skip link targeting the main content region", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./OpsConsoleController.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

    expect(source).toContain('className="ops-skip-link"');
    expect(source).toContain('href="#ops-main-content"');
    expect(source).toContain("跳转到主要内容");
    expect(source).toContain('id="ops-main-content" className="ops-content" role="main"');
    expect(styles).toContain(".ops-skip-link:focus-visible");
  });
});

describe("password session gate", () => {
  it("shows a retryable error when password session validation fails", () => {
    expect(opsSessionGateState(true, false, "session projection failed")).toBe("error");
    expect(opsSessionGateState(true, false)).toBe("loading");
    expect(opsSessionGateState(true, true, "stale error")).toBe("ready");
    expect(opsSessionGateState(false, false, "local connection error")).toBe("error");
  });

  it("keeps a visible retry action for session transport failures", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./OpsConsoleController.tsx", import.meta.url), "utf8");

    expect(source).toContain('sessionGate === "error"');
    expect(source).toContain('opsSessionGateState(managedOpsSession, Boolean(model.opsSession), sessionError)');
    expect(source).toContain('title="无法验证运营会话"');
    expect(source).toContain('onClick={() => void model.load()}');
  });

  it("restores the password workbench from the same local storage used by the API client", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./OpsConsoleController.tsx", import.meta.url), "utf8");

    expect(source).toContain('const stored = localStorage.getItem("ops_workbench")');
    expect(source).not.toContain('sessionStorage.getItem("ops_workbench")');
  });

  it("routes unauthenticated operators to the keyboard-accessible password form", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./OpsConsoleController.tsx", import.meta.url), "utf8");

    expect(source).toContain("<PlatformOpsLoginPage");
    expect(source).toContain("expectedUnauthenticated");
    expect(source).toContain('managedSession={false}');
    expect(source).toContain("error={expectedUnauthenticated ? undefined : sessionError}");
  });
});

describe("desktop loading feedback", () => {
  it("summarizes dataset failures while retaining the complete diagnostic detail", () => {
    const warning = opsLoadWarningPresentation("部分数据集刷新失败（workspace.metrics、knowledge.rule.list）。页面保留上次成功数据，这些值可能已过期：服务不可用");
    expect(warning.summary).toBe("2 个数据集刷新失败，页面已保留上次成功数据。");
    expect(warning.detail).toContain("workspace.metrics");
    expect(opsLoadWarningPresentation("规则数据加载失败，请重试")).toEqual({ summary: "规则数据加载失败，请重试", detail: undefined });
  });

  it("announces the highest-priority main content transition", () => {
    expect(opsContentLoadingMessage("ready", true, true)).toContain("旧工作台数据已清除");
    expect(opsContentLoadingMessage("loading", false, true)).toBe("正在验证运营权限");
    expect(opsContentLoadingMessage("ready", false, true)).toBe("正在刷新运营数据");
    expect(opsContentLoadingMessage("ready", false, false)).toBe("");
  });

  it("marks the desktop main region busy and exposes a polite live status", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./OpsConsoleController.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-busy={Boolean(loadingMessage)}');
    expect(source).toContain('role="status" aria-live="polite" aria-atomic="true"');
  });
});

describe("access denied evidence", () => {
  it("reports granted capabilities only when the server projection was returned", () => {
    expect(accessDeniedGrantedCapabilities(createAuthorizationProjection({
      actor_id: "operator-1", workspace_id: "platform", roles: [], workspace_granted: true, capabilities: [],
    }, true))).toEqual([]);
    expect(accessDeniedGrantedCapabilities(createAuthorizationProjection(undefined, true))).toBeUndefined();
    expect(accessDeniedGrantedCapabilities(createAuthorizationProjection({
      actor_id: "operator-1", workspace_id: "platform", roles: [], workspace_granted: true,
      capabilities: ["z.read", "a.read"],
    }, true))).toEqual(["a.read", "z.read"]);
  });

  it("prefers the server decision reason over the transport error code", () => {
    expect(accessDeniedReasonCode({ code: "FORBIDDEN", details: { reason_code: "SCOPE_MISMATCH" } })).toBe("SCOPE_MISMATCH");
    expect(accessDeniedReasonCode({ code: "HTTP_403", details: {} })).toBe("HTTP_403");
  });

  it("projects server decision and missing obligations without inventing evidence", () => {
    expect(accessDeniedEvidence({ details: {
      decision_id: " decision-1 ",
      obligations_missing: ["mfa", " approval ", "", 4],
    } })).toEqual({ decisionId: "decision-1", obligationsMissing: ["mfa", "approval"] });
    expect(accessDeniedEvidence({ details: { decision_id: "", obligations_missing: [] } })).toEqual({});
  });
});

describe("openBrandStore", () => {
  it("sets the exact store queue scope and carries it in the task route", async () => {
    const setQueueFilters = vi.fn();
    const onNavigate = vi.fn();
    const onNavigateWithQuery = vi.fn();

    await expect(openBrandStore({ setQueueFilters }, onNavigate, "taobao", "store-1", onNavigateWithQuery)).resolves.toBe(true);

    expect(setQueueFilters).toHaveBeenCalledWith({ platform: "taobao", accountId: "store-1" });
    expect(onNavigateWithQuery).toHaveBeenCalledWith("tasks", { platform: "taobao", accountId: "store-1" });
    expect(onNavigate).not.toHaveBeenCalled();
    await expect(openBrandStore({ setQueueFilters }, onNavigate, "unknown", "store-1", onNavigateWithQuery)).resolves.toBe(false);
    expect(setQueueFilters).toHaveBeenCalledTimes(1);
    expect(onNavigateWithQuery).toHaveBeenCalledTimes(1);
  });
});
