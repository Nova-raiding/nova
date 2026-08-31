import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeOpsError, rpcForWorkspace } from "../api/opsClient.js";
import type { AuthorizationProjection } from "../authz/authorization.js";

export type MemberRole = "workspace_owner" | "merchant_admin" | "operator" | "support" | "finance" | "platform_ops";
export type MemberStatus = "invited" | "active" | "suspended";

export interface WorkspaceMember {
  id: string;
  identityId?: string;
  externalSubject: string;
  displayName: string;
  role: MemberRole;
  status: MemberStatus;
  invitedBy?: string;
  revision: number;
  createdAt?: string;
  updatedAt: string;
  governance?: {
    protectedTarget: boolean;
    canChangeTarget: boolean;
    canDeactivateTarget: boolean;
    reasonCode?: string;
  };
}

export interface MembersClient {
  list(workspaceId: string): Promise<WorkspaceMember[]>;
  invite(workspaceId: string, input: { externalSubject: string; displayName: string; role: MemberRole; reason: string }): Promise<WorkspaceMember>;
  changeRole(workspaceId: string, member: WorkspaceMember, role: MemberRole, reason: string): Promise<WorkspaceMember>;
  deactivate(workspaceId: string, member: WorkspaceMember, reason: string): Promise<WorkspaceMember>;
  reactivate(workspaceId: string, member: WorkspaceMember, reason: string): Promise<WorkspaceMember>;
}

type RpcCall = (workspaceId: string, method: string, params?: Record<string, string>) => Promise<unknown>;

export function createMembersClient(call: RpcCall = rpcForWorkspace): MembersClient {
  const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
  const list = (workspaceId: string) => call(workspaceId, "ops.members.list") as Promise<WorkspaceMember[]>;
  const assertFresh = async (workspaceId: string, member: WorkspaceMember) => {
    const current = (await list(workspaceId)).find((item) => item.externalSubject === member.externalSubject);
    if (!current || current.revision !== member.revision) throw failure("MEMBER_REVISION_CONFLICT", "成员信息已变化，请刷新后重试");
  };
  const upsert = (
    workspaceId: string,
    member: Pick<WorkspaceMember, "externalSubject" | "displayName" | "role"> & Partial<Pick<WorkspaceMember, "status" | "revision">>,
    reason: string,
  ) => call(workspaceId, "ops.member.upsert", {
    external_subject: member.externalSubject,
    display_name: member.displayName,
    role: member.role,
    ...(member.status ? { status: member.status } : {}),
    ...(member.revision !== undefined ? { expected_revision: String(member.revision) } : {}),
    reason,
  }) as Promise<WorkspaceMember>;

  return {
    list,
    invite: async (workspaceId, input) => {
      if ((await list(workspaceId)).some((item) => item.externalSubject === input.externalSubject)) throw failure("MEMBER_ALREADY_EXISTS", "该用户已经是当前工作区成员，请使用角色调整操作");
      return upsert(workspaceId, { ...input, status: "invited" }, input.reason);
    },
    changeRole: async (workspaceId, member, role, reason) => {
      await assertFresh(workspaceId, member);
      return upsert(workspaceId, { ...member, role }, reason);
    },
    deactivate: async (workspaceId, member, reason) => {
      await assertFresh(workspaceId, member);
      return call(workspaceId, "ops.member.suspend", {
        external_subject: member.externalSubject,
        expected_revision: String(member.revision),
        reason,
      }) as Promise<WorkspaceMember>;
    },
    reactivate: async (workspaceId, member, reason) => {
      await assertFresh(workspaceId, member);
      return upsert(workspaceId, { ...member, status: "active" }, reason);
    },
  };
}

export class MembersRequestGate {
  private generation = 0;
  begin(workspaceId: string) {
    const generation = ++this.generation;
    return { workspaceId, generation };
  }
  isCurrent(token: { workspaceId: string; generation: number }, workspaceId: string) {
    return token.workspaceId === workspaceId && token.generation === this.generation;
  }
  invalidate() {
    this.generation += 1;
  }
}

export function memberCapabilities(authorization: AuthorizationProjection, actorId: string | undefined, member?: WorkspaceMember) {
  const manager = authorization.can("workspace.member.manage");
  const canAssignOwner = authorization.can("workspace.status.update");
  // Target-sensitive decisions are server projections. Missing governance is
  // fail-closed: a stale/legacy response must not manufacture write access.
  const protectedTarget = member ? !(member.governance?.canChangeTarget) : false;
  return {
    canManage: manager,
    canAssignOwner,
    canAssignPlatformOps: false,
    canChangeTarget: manager && Boolean(member?.governance?.canChangeTarget),
    canDeactivateTarget: manager && Boolean(member?.governance?.canDeactivateTarget),
  };
}

function membersError(cause: unknown) {
  const code = (cause as { code?: string } | undefined)?.code;
  if (code === "MEMBER_REVISION_CONFLICT") return "成员信息已被其他管理员更新，请刷新后重试。";
  if (code === "MEMBER_ALREADY_EXISTS") return "该用户已经是当前工作区成员，请使用角色调整操作。";
  if (code === "LAST_WORKSPACE_OWNER_REQUIRED") return "不能降级或停用最后一名有效工作区所有者。";
  if (code === "MEMBER_ALREADY_ACTIVE" || code === "MEMBER_ALREADY_SUSPENDED") return "成员状态已变化，请刷新后重试。";
  return describeOpsError(cause);
}

export function useMembers(workspaceId: string | undefined, client: MembersClient = createMembersClient()) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const gate = useRef(new MembersRequestGate());
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const load = useCallback(async () => {
    if (!workspaceId) {
      gate.current.invalidate();
      setMembers([]);
      setError("请先选择工作区后再管理成员。");
      return;
    }
    const token = gate.current.begin(workspaceId);
    setLoading(true);
    setError("");
    try {
      const result = await client.list(workspaceId);
      if (gate.current.isCurrent(token, workspaceRef.current ?? "")) setMembers(result);
    } catch (cause) {
      if (gate.current.isCurrent(token, workspaceRef.current ?? "")) setError(membersError(cause));
    } finally {
      if (gate.current.isCurrent(token, workspaceRef.current ?? "")) setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    setMembers([]);
    setError("");
    void load();
    return () => gate.current.invalidate();
  }, [load]);

  const mutate = useCallback(async (operation: (activeWorkspaceId: string) => Promise<WorkspaceMember>) => {
    if (!workspaceId) throw new Error("请先选择工作区后再管理成员。");
    const token = gate.current.begin(workspaceId);
    setMutating(true);
    setError("");
    try {
      const member = await operation(workspaceId);
      if (gate.current.isCurrent(token, workspaceRef.current ?? "")) setMembers(await client.list(workspaceId));
      return member;
    } catch (cause) {
      if (gate.current.isCurrent(token, workspaceRef.current ?? "")) setError(membersError(cause));
      throw cause;
    } finally {
      if (gate.current.isCurrent(token, workspaceRef.current ?? "")) setMutating(false);
    }
  }, [workspaceId]);

  return useMemo(() => ({
    members,
    loading,
    mutating,
    error,
    clearError: () => setError(""),
    load,
    invite: (input: Parameters<MembersClient["invite"]>[1]) => mutate((id) => client.invite(id, input)),
    changeRole: (member: WorkspaceMember, role: MemberRole, reason: string) => mutate((id) => client.changeRole(id, member, role, reason)),
    deactivate: (member: WorkspaceMember, reason: string) => mutate((id) => client.deactivate(id, member, reason)),
    reactivate: (member: WorkspaceMember, reason: string) => mutate((id) => client.reactivate(id, member, reason)),
  }), [client, error, load, loading, members, mutate, mutating]);
}
