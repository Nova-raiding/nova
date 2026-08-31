import { describe, expect, it } from "vitest";
import { visibleUsersGovernanceSections } from "./UsersGovernanceWorkspace";

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
});
