import { describe, expect, it } from "vitest";
import type { PlatformUser } from "../../types/ops.js";
import { membershipAccessActionContext } from "./UserDirectorySection.js";

function membership(overrides: Partial<PlatformUser>): PlatformUser {
  return {
    id: "member-1",
    externalSubject: "subject-1",
    displayName: "Alice",
    role: "operator",
    status: "active",
    updatedAt: "2026-10-09T00:00:00.000Z",
    workspaceId: "workspace-1",
    enterpriseName: "北区商家",
    workspaceStatus: "active",
    ...overrides,
  };
}

describe("UserDirectorySection membership action context regression", () => {
  it("targets the first suspended membership with enable wording and its exact workspace", () => {
    const firstMembership = membership({ status: "suspended" });
    const anotherWorkspace = membership({
      id: "member-2",
      workspaceId: "workspace-2",
      enterpriseName: "南区商家",
      status: "active",
    });

    const action = membershipAccessActionContext([firstMembership, anotherWorkspace][0]);

    expect(action).toEqual({
      action: "启用",
      status: "已停用",
      target: "Alice · 北区商家（workspace-1）",
      buttonLabel: "启用 Alice · 北区商家（workspace-1） 的成员访问",
    });
  });
});
