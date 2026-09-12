import { Button } from "antd";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { UsersGovernanceWorkspace } from "../components/users/UsersGovernanceWorkspace";

interface UsersPageProps {
  model: OpsConsoleModel;
}

type UsersPageAuthorization = Pick<OpsConsoleModel["authorization"], "can" | "canAny">;

export function usersPageCapabilityState(authorization: UsersPageAuthorization) {
  const canReadDirectory = authorization.can("identity.read");
  const canReadWorkspaces = authorization.can("workspace.directory.read");
  const canReadAuthorization = authorization.canAny(["authorization.role.read", "authorization.grant.read"]);
  const canWrite = authorization.canAny([
    "identity.update",
    "workspace.status.update",
    "authorization.role.manage",
    "authorization.grant.manage",
  ]);

  return {
    canRead: canReadDirectory || canReadWorkspaces || canReadAuthorization,
    canWrite,
    canReadDirectory,
    canReadWorkspaces,
    canReadAuthorization,
  };
}

export function UsersPage({ model }: UsersPageProps) {
  const capabilityState = usersPageCapabilityState(model.authorization);

  return (
    <OpsPage
      eyebrow="PLATFORM GOVERNANCE"
      title="用户中心"
      description="按任务管理用户身份、企业主体状态与平台授权；用户详情同时关联成员角色、权限、钱包余额、扣款/账单状态、任务用量、订单权益、店铺范围和审计记录。只展示当前角色可读取的治理区域，所有写入仍由服务端逐次鉴权并审计。"
      actions={<Button type="primary" disabled={!capabilityState.canRead} loading={model.loading} title={!capabilityState.canRead ? "当前会话没有用户治理读取能力" : undefined} onClick={() => void model.load()}>刷新目录</Button>}
    >
      <div className="ops-users-page">
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <UsersGovernanceWorkspace model={model} onRefresh={() => void model.load()} />
      </div>
    </OpsPage>
  );
}
