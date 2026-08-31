import { describe, expect, it, vi } from "vitest";
import { createMembersClient, memberCapabilities, MembersRequestGate, type WorkspaceMember } from "./useMembers.js";
import { createAuthorizationProjection } from "../authz/authorization.js";

const member: WorkspaceMember = { id: "m1", externalSubject: "user_1", displayName: "用户一", role: "operator", status: "active", revision: 4, updatedAt: "2026-08-29T00:00:00.000Z", governance: { protectedTarget: false, canChangeTarget: true, canDeactivateTarget: true } };

describe("members governance helpers", () => {
  it("maps invite, role, deactivate and reactivate to existing audited RPCs", async () => {
    const call = vi.fn(async (_workspaceId: string, method: string) => method === "ops.members.list" ? [member] : member);
    const client = createMembersClient(call);
    await client.invite("ws_a", { externalSubject: "user_2", displayName: "用户二", role: "support", reason: "客服入职" });
    await client.changeRole("ws_a", member, "finance", "转岗财务");
    await client.deactivate("ws_a", member, "员工离职");
    await client.reactivate("ws_a", member, "重新入职");
    expect(call.mock.calls.filter((entry) => entry[1] !== "ops.members.list")).toEqual([
      ["ws_a", "ops.member.upsert", expect.objectContaining({ external_subject: "user_2", role: "support", status: "invited", reason: "客服入职" })],
      ["ws_a", "ops.member.upsert", expect.objectContaining({ external_subject: "user_1", role: "finance", status: "active", expected_revision: "4", reason: "转岗财务" })],
      ["ws_a", "ops.member.suspend", { external_subject: "user_1", expected_revision: "4", reason: "员工离职" }],
      ["ws_a", "ops.member.upsert", expect.objectContaining({ external_subject: "user_1", status: "active", expected_revision: "4", reason: "重新入职" })],
    ]);
  });

  it("blocks stale mutations and accidental invite-overwrite before sending a write", async () => {
    const call = vi.fn(async (_workspaceId: string, method: string) => method === "ops.members.list" ? [{ ...member, revision: 5 }] : member);
    const client = createMembersClient(call);
    await expect(client.changeRole("ws_a", member, "finance", "转岗财务")).rejects.toMatchObject({ code: "MEMBER_REVISION_CONFLICT" });
    await expect(client.invite("ws_a", { externalSubject: "user_1", displayName: "重复用户", role: "support", reason: "重复邀请" })).rejects.toMatchObject({ code: "MEMBER_ALREADY_EXISTS" });
    expect(call.mock.calls.some((entry) => entry[1] === "ops.member.upsert")).toBe(false);
  });

  it("enforces target-sensitive RBAC in the UI", () => {
    const authorization = (capabilities: string[]) => createAuthorizationProjection({ actor_id: "actor", workspace_id: "ws_a", roles: [], workspace_granted: true, capabilities }, true);
    const admin = authorization(["workspace.member.manage"]);
    const owner = authorization(["workspace.member.manage", "workspace.status.update"]);
    expect(memberCapabilities(admin, "admin", { ...member, governance: { protectedTarget: true, canChangeTarget: false, canDeactivateTarget: false } }).canChangeTarget).toBe(false);
    expect(memberCapabilities(owner, "owner", { ...member, governance: { protectedTarget: false, canChangeTarget: true, canDeactivateTarget: true } }).canChangeTarget).toBe(true);
    expect(memberCapabilities(owner, "owner", { ...member, governance: { protectedTarget: true, canChangeTarget: false, canDeactivateTarget: false, reasonCode: "PLATFORM_ROLE_CHANGE_REQUIRES_PLATFORM_WORKBENCH" } }).canChangeTarget).toBe(false);
    expect(memberCapabilities(owner, "user_1", { ...member, governance: { protectedTarget: false, canChangeTarget: true, canDeactivateTarget: false, reasonCode: "SELF_SUSPENSION_DENIED" } }).canDeactivateTarget).toBe(false);
    expect(memberCapabilities(owner, "owner", { ...member, governance: undefined }).canChangeTarget).toBe(false);
  });

  it("rejects stale responses after a tenant switch", () => {
    const gate = new MembersRequestGate();
    const oldRequest = gate.begin("ws_old");
    const currentRequest = gate.begin("ws_new");
    expect(gate.isCurrent(oldRequest, "ws_new")).toBe(false);
    expect(gate.isCurrent(currentRequest, "ws_new")).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(currentRequest, "ws_new")).toBe(false);
  });
});
