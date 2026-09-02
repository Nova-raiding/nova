import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { MembersClient } from "../../hooks/useMembers";
import { MembersSection } from "./MembersSection.js";
import { createAuthorizationProjection } from "../../authz/authorization.js";

const authorization = (capabilities: string[]) => createAuthorizationProjection({ actor_id: "actor", workspace_id: "ws_a", roles: [], workspace_granted: true, capabilities }, true);

const client: MembersClient = {
  list: async () => [],
  invite: async () => { throw new Error("unused"); },
  changeRole: async () => { throw new Error("unused"); },
  deactivate: async () => { throw new Error("unused"); },
  reactivate: async () => { throw new Error("unused"); },
};

describe("MembersSection", () => {
  it("renders an explicitly labelled, reason-required governance form", () => {
    const model = { opsSession: { actor_id: "owner_1", workspace_id: "ws_a", roles: ["workspace_owner"], workspace_granted: true, assignable_roles: ["merchant_admin", "operator", "support", "finance", "workspace_owner"] }, authorization: authorization(["workspace.member.manage", "workspace.status.update"]) } as OpsConsoleModel;
    const html = renderToStaticMarkup(createElement(MembersSection, { model, client }));
    expect(html).toContain("邀请工作区成员");
    expect(html).toContain("邀请原因");
    expect(html).toContain("用于权限审计");
    expect(html).toContain("邀请成员");
  });

  it("keeps member governance discoverable for platform operations", () => {
    const model = { opsSession: { actor_id: "ops_1", workspace_id: "ws_a", roles: ["platform_ops"], workspace_granted: true, assignable_roles: ["merchant_admin", "operator", "support", "finance", "workspace_owner", "platform_ops"] }, authorization: authorization(["workspace.member.manage"]) } as OpsConsoleModel;
    const html = renderToStaticMarkup(createElement(MembersSection, { model, client }));
    expect(html).toContain("当前租户成员");
    expect(html).toContain("邀请工作区成员");
    expect(html).toContain("邀请成员");
  });

  it("announces read-only RBAC instead of exposing an enabled mutation form", () => {
    const model = { opsSession: { actor_id: "support_1", workspace_id: "ws_a", roles: ["support"], workspace_granted: true }, authorization: authorization(["workspace.member.read"]) } as OpsConsoleModel;
    const html = renderToStaticMarkup(createElement(MembersSection, { model, client }));
    expect(html).toContain("当前角色只有成员查看权限");
    expect(html).toContain("disabled");
  });

  it("provides focusable initial-load recovery and announces table loading", () => {
    const source = readFileSync(new URL("./MembersSection.tsx", import.meta.url), "utf8");

    expect(source).toContain('role="alert" aria-live="assertive" aria-atomic="true"');
    expect(source).toContain('tabIndex={initialLoadFailed ? -1 : undefined}');
    expect(source).toContain('aria-label={initialLoadFailed ? "成员列表加载错误摘要" : undefined}');
    expect(source).toContain('aria-label="刷新成员列表"');
    expect(source).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(source).toContain('aria-busy={state.loading}');
  });
});
