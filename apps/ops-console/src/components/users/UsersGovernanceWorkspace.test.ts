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

  it("returns no task area when the session has no governance read capability", () => {
    expect(visibleUsersGovernanceSections(authorization([]))).toEqual([]);
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
});
