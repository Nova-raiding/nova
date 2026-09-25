import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { UsersGovernanceWorkspace, visibleUsersGovernanceSections } from "./UsersGovernanceWorkspace";

function authorization(capabilities: string[]) {
  const allowed = new Set(capabilities);
  return { can: (capability: string) => allowed.has(capability) };
}

describe("visibleUsersGovernanceSections", () => {
  it("keeps read-only identity users in the user directory without exposing write-only sections", () => {
    expect(visibleUsersGovernanceSections(authorization(["identity.read"]))).toEqual(["directory"]);
  });

  it("shows only the task areas backed by server capabilities", () => {
    expect(visibleUsersGovernanceSections(authorization([
      "workspace.directory.read",
      "authorization.grant.read",
    ]))).toEqual(["workspaces", "authorization"]);
  });

  it("exposes the authorization center only to sessions with an authorization read capability", () => {
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.read"]))).toEqual(["authorization"]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.grant.read"]))).toEqual(["authorization"]);
    expect(visibleUsersGovernanceSections(authorization(["authorization.role.manage"]))).toEqual([]);
  });

  it("returns no task area when the session has no governance read capability", () => {
    expect(visibleUsersGovernanceSections(authorization([]))).toEqual([]);
  });

  it("places member invitations inside the user center", () => {
    expect(visibleUsersGovernanceSections(authorization(["workspace.member.read"]))).toEqual(["members"]);
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
      model: { authorization: authorization(["authorization.grant.read"]) } as never,
    }));
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("权限与授权");
  });

  it("uses labels that describe the data in each user governance tab", () => {
    const markup = renderToStaticMarkup(createElement(UsersGovernanceWorkspace, {
      model: { authorization: authorization(["workspace.directory.read", "workspace.member.read"]) } as never,
    }));
    expect(markup).toContain("商家工作区");
    expect(markup).toContain(">成员<");
    expect(markup).not.toContain("月费详情");
    expect(markup).not.toContain("创意点详情");
    const source = readFileSync(new URL("./UsersGovernanceWorkspace.tsx", import.meta.url), "utf8");
    expect(source).toContain('key: "directory", label: "已入驻用户"');
    expect(source).not.toContain('label: "接入详情"');
  });
});
