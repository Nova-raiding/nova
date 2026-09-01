import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAuthorizationProjection } from "../../authz/authorization.js";
import { AuthorizationProvider } from "../../authz/AuthorizationProvider.js";
import type { OpsSession } from "../../types/ops.js";
import { AccessDeniedResult } from "./AccessDeniedResult.js";
import { PermissionGate } from "./PermissionGate.js";
import { focusActiveWorkbenchControl, OpsWorkbenchSwitcher } from "./OpsWorkbenchSwitcher.js";
import { activeJitGrantForNow, formatJitRemaining, RoleScopeBar, workbenchBoundaryMessage } from "./RoleScopeBar.js";

const session: OpsSession = {
  actor_id: "actor_1", workspace_id: "ws_1", roles: ["platform_ops"], canonical_roles: ["ops_admin"],
  workspace_granted: true, capabilities: ["platform.summary.read"], policy_version: "2026-08-31.v1",
  scopes: [{ type: "platform", ids: ["*"] }],
  schema_version: 2, workbench: "platform", available_workbenches: ["platform", "workspace"], context_id: "ctx_1", context_version: "1",
};

describe("desktop permission UX", () => {
  it("restores keyboard focus to the active workbench control", () => {
    let focused = false;
    const active = { focus: (options?: FocusOptions) => { focused = options?.preventScroll === true; } };
    const root = { querySelector: () => active } as unknown as Pick<HTMLElement, "querySelector">;
    expect(focusActiveWorkbenchControl(root)).toBe(true);
    expect(focused).toBe(true);
    expect(focusActiveWorkbenchControl(null)).toBe(false);
  });
  it("states the platform and merchant workbench boundary explicitly", () => {
    expect(workbenchBoundaryMessage("platform")).toContain("商家操作需切换到商家工作区");
    expect(workbenchBoundaryMessage("workspace")).toContain("不包含平台运营能力");
  });
  it("formats a live JIT countdown without exposing a token", () => {
    expect(formatJitRemaining(15 * 60 * 1000 + 1200)).toBe("15:02");
    expect(formatJitRemaining(-1)).toBe("00:00");
  });
  it("hides an expired JIT grant before the replacement session arrives", () => {
    const grants = [{ id: "grant_1", expires_at: "2026-08-31T10:00:00.000Z" }];
    expect(activeJitGrantForNow(grants, Date.parse("2026-08-31T09:59:59.999Z"))).toBe(grants[0]);
    expect(activeJitGrantForNow(grants, Date.parse("2026-08-31T10:00:00.000Z"))).toBeUndefined();
  });
  it("exposes the server-projected JIT mode, exact scope and use budget", () => {
    const html = renderToStaticMarkup(<RoleScopeBar
      session={{ ...session, temporary_grants: [{ id: "grant_1", access_mode: "write", workspace_id: "ws_1", resource_scope: { type: "workspace", ids: ["ws_1"] }, expires_at: "2999-01-01T00:00:00.000Z", max_uses: 3, use_count: 1 }] }}
      authorization={createAuthorizationProjection(session, true)}
    />);
    expect(html).toContain("临时授权 · 可写");
    expect(html).toContain("范围 workspace:ws_1");
    expect(html).toContain("使用 1/3");
    expect(html).toContain('aria-live="polite"');
  });
  it("offers an explicit exit action while a JIT grant is active", () => {
    const html = renderToStaticMarkup(<RoleScopeBar
      session={{ ...session, temporary_grants: [{ id: "grant_1", access_mode: "read", workspace_id: "ws_1", resource_scope: { type: "workspace", ids: ["ws_1"] }, expires_at: "2999-01-01T00:00:00.000Z" }] }}
      authorization={createAuthorizationProjection(session, true)}
      onJitExit={() => undefined}
    />);
    expect(html).toContain("退出临时授权");
    expect(html).toContain('aria-label="退出当前临时授权"');
  });
  it("keeps identity, workbench, scope and policy visible", () => {
    const html = renderToStaticMarkup(<RoleScopeBar session={session} authorization={createAuthorizationProjection(session, true)} />);
    expect(html).toContain("平台运营");
    expect(html).toContain("actor_1");
    expect(html).toContain("平台控制台");
    expect(html).toContain("平台全局");
    expect(html).toContain("2026-08-31.v1");
    expect(html).toContain("商家工作区");
    expect(html).toContain("平台运营视图");
  });

  it("announces whether the server authorization projection is verified", () => {
    const verified = renderToStaticMarkup(<RoleScopeBar session={session} authorization={createAuthorizationProjection(session, true)} />);
    expect(verified).toContain("授权状态：已由服务端验证");
    expect(verified).toContain('id="role-scope-verification"');
    expect(verified).toContain('aria-live="polite"');
    expect(verified).toContain('aria-atomic="true"');

    const pending = renderToStaticMarkup(<RoleScopeBar authorization={createAuthorizationProjection(undefined, true)} activeWorkbench="workspace" />);
    expect(pending).toContain("授权状态：未验证，正在等待服务端授权");
    expect(pending).toContain('aria-describedby="role-scope-verification role-scope-boundary"');
  });

  it("keeps a single server-projected workbench static", () => {
    const workspaceSession = { ...session, workbench: "workspace" as const, available_workbenches: ["workspace" as const], scopes: [{ type: "workspace" as const, ids: ["ws_1"] }] };
    const html = renderToStaticMarkup(<RoleScopeBar session={workspaceSession} authorization={createAuthorizationProjection(workspaceSession, true)} />);
    expect(html).toContain("商家工作区");
    expect(html).not.toContain("平台控制台");
    expect(html).not.toContain("当前运营工作台");
    expect(html).toContain("商家自运营视图");
  });

  it("keeps server candidates switchable when the active projection is deny-all", () => {
    const deniedSession = { ...session, capabilities: [] };
    const authorization = createAuthorizationProjection(deniedSession, true);
    const html = renderToStaticMarkup(<RoleScopeBar session={deniedSession} authorization={authorization} activeWorkbench="platform" onWorkbenchChange={() => undefined} />);
    expect(authorization.can("platform.summary.read")).toBe(false);
    expect(html).toContain("平台控制台");
    expect(html).toContain("商家工作区");
    expect(html).toContain("当前运营工作台");
  });

  it("retains the last server-projected switch targets while the next workbench session is unavailable", () => {
    const html = renderToStaticMarkup(<RoleScopeBar authorization={createAuthorizationProjection(undefined, true)} activeWorkbench="workspace" availableWorkbenches={["platform", "workspace"]} onWorkbenchChange={() => undefined} />);
    expect(html).toContain("平台控制台");
    expect(html).toContain("商家工作区");
    expect(html).toContain("当前运营工作台");
  });

  it("announces workbench switching while controls are disabled", () => {
    const html = renderToStaticMarkup(<OpsWorkbenchSwitcher
      value="platform"
      available={["platform", "workspace"]}
      switching
      onChange={() => undefined}
    />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("正在切换运营工作台，请稍候");
  });

  it("hides denied content and explains read-only state", () => {
    const authorization = createAuthorizationProjection(session, true);
    const hidden = renderToStaticMarkup(<AuthorizationProvider authorization={authorization}><PermissionGate capability="identity.update"><button>停用身份</button></PermissionGate></AuthorizationProvider>);
    const readOnly = renderToStaticMarkup(<AuthorizationProvider authorization={authorization}><PermissionGate capability="identity.update" behavior="readonly"><button>停用身份</button></PermissionGate></AuthorizationProvider>);
    expect(hidden).not.toContain("停用身份");
    expect(readOnly).toContain("当前范围为只读");
    expect(readOnly).toContain("identity.update");
  });

  it("keeps a denied action keyboard-focusable with an explicit disabled reason", () => {
    const authorization = createAuthorizationProjection(session, true);
    const html = renderToStaticMarkup(
      <AuthorizationProvider authorization={authorization}>
        <PermissionGate capability="identity.update" behavior="disabled" disabledReason="请先切换到具备身份治理能力的工作区">
          <button onClick={() => undefined}>停用身份</button>
        </PermissionGate>
      </AuthorizationProvider>,
    );
    expect(html).toContain('class="permission-disabled"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="操作暂不可用"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('disabled=""');
    expect(html).toContain("请先切换到具备身份治理能力的工作区");
    expect(html).not.toContain('停用身份</button></span>');
  });

  it("explains the server-projected scope in read-only UX", () => {
    const scoped = createAuthorizationProjection({ ...session, effective_permissions: [
      { capability: "identity.update", effect: "deny", scope: { type: "workspace", ids: ["ws_1"] } },
    ] }, true);
    const html = renderToStaticMarkup(<AuthorizationProvider authorization={scoped}><PermissionGate capability="identity.update" behavior="readonly"><button>停用身份</button></PermissionGate></AuthorizationProvider>);
    expect(html).toContain("当前授权范围未返回");
    expect(html).toContain("identity.update");
  });

  it("shows denied capability, scope and request evidence", () => {
    const html = renderToStaticMarkup(<AccessDeniedResult domainLabel="用户与租户" capability="identity.read" scope={{ kind: "workspace", id: "ws_1" }} requestId="req_1" traceId="trace_1" reasonCode="CAPABILITY_DENIED" onBack={() => undefined} onRefresh={() => undefined} />);
    expect(html).toContain("identity.read");
    expect(html).toContain("workspace:ws_1");
    expect(html).toContain("req_1");
    expect(html).toContain("trace_1");
    expect(html).toContain("CAPABILITY_DENIED");
    expect(html).toContain("当前会话在workspace:ws_1范围内缺少 identity.read 能力");
    expect(html).toContain("请求 ID：req_1");
    expect(html).toContain("access-denied-actions");
    expect(html).toContain("刷新权限");
    expect(html).toContain('role="alert"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-labelledby="access-denied-evidence-title"');
    expect(html).toContain("权限拒绝详情");
  });
});
