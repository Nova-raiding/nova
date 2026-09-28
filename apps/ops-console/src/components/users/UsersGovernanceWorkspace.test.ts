import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { PlatformMembersUnavailable, UsersGovernanceWorkspace, visibleUsersGovernanceSections } from "./UsersGovernanceWorkspace";

function authorization(capabilities: string[], roles: string[] = [], scope: "platform" | "workspace" = "platform") {
  const allowed = new Set(capabilities);
  return { can: (capability: string) => allowed.has(capability), roles, scope: { kind: scope } };
}

describe("visibleUsersGovernanceSections", () => {
  it("keeps read-only identity users in the user directory without exposing write-only sections", () => {
    expect(visibleUsersGovernanceSections(authorization(["identity.read"]))).toEqual(["directory"]);
  });

  it("shows only the task areas backed by server capabilities", () => {
    expect(visibleUsersGovernanceSections(authorization([
      "workspace.directory.read",
      "authorization.grant.read",
    ], ["ops_admin"]), "hyp@sn.com")).toEqual(["workspaces", "authorization"]);
  });

  it("exposes authorization only to the two designated accounts with server-granted read capability", () => {
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.read"], ["ops_admin"]), "hyp@sn.com")).toEqual(["authorization"]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.grant.read"], ["ops_admin"]), "hxd@sn.com")).toEqual(["authorization"]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.read"], ["ops_admin"]), "devide@sn.com")).toEqual([]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.read"], ["platform_admin"]), "other@sn.com")).toEqual([]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.read"], ["security_admin"]), "hyp@sn.com")).toEqual([]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.read"], ["ops_admin"], "workspace"), "hyp@sn.com")).toEqual([]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.manage"], ["ops_admin"]), "hyp@sn.com")).toEqual([]);
  });

  it("returns no task area when the session has no governance read capability", () => {
    expect(visibleUsersGovernanceSections(authorization([]))).toEqual([]);
  });

  it("places member invitations inside the user center", () => {
    expect(visibleUsersGovernanceSections(authorization(["workspace.member.read"]))).toEqual(["members"]);
  });

  it("does not offer member operations in the platform global context", () => {
    const markup = renderToStaticMarkup(createElement(PlatformMembersUnavailable));
    expect(markup).toContain("请先进入商家工作区");
    expect(markup).not.toContain("邀请工作区成员");
    expect(readFileSync(new URL("./UsersGovernanceWorkspace.tsx", import.meta.url), "utf8")).toContain('model.opsSession?.workspace_id\n    ? <MembersSection model={model} />\n    : <PlatformMembersUnavailable />');
  });

  it("makes the unavailable page state discoverable and recoverable", () => {
    const markup = renderToStaticMarkup(createElement(UsersGovernanceWorkspace, {
      model: { authorization: authorization([]) } as never,
      onRefresh: () => undefined,
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-labelledby="users-governance-unavailable-title"');
    expect(markup).toContain("刷新用户治理权限");
    expect(markup).toContain("不会把未授权结果显示为空数据");
  });

  it("mounts the authorization center from the user governance route", () => {
    const markup = renderToStaticMarkup(createElement(UsersGovernanceWorkspace, {
      model: { authorization: authorization(["authorization.grant.read"], ["ops_admin"]), opsSession: { account_login: "hyp@sn.com" } } as never,
    }));
    expect(markup).not.toContain("更多治理");
    expect(markup).toContain("权限与授权");
  });

  it("uses labels that describe the data in each user governance tab", () => {
    const markup = renderToStaticMarkup(createElement(UsersGovernanceWorkspace, {
      model: {
        authorization: authorization(["workspace.directory.read", "workspace.member.read"]),
        workspaceDirectory: { offset: 0, limit: 20, total: 0, items: [] },
        workspaceDirectoryLoading: false,
        workspaceDirectoryError: "",
        dataSetError: () => "",
        opsSession: undefined,
      } as never,
    }));
    expect(markup).toContain("商家工作区");
    expect(markup).toContain("其他页面：成员");
    expect(markup).not.toContain("月费详情");
    expect(markup).not.toContain("创意点详情");
    const source = readFileSync(new URL("./UsersGovernanceWorkspace.tsx", import.meta.url), "utf8");
    expect(source).toContain('key: "directory", label: "已接入用户"');
    expect(source).not.toContain('label: "接入详情"');
  });
});
