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
  const canWrite = authorization.canAny([
    "identity.update",
    "workspace.status.update",
    "authorization.role.manage",
    "authorization.grant.manage",
  ]);

  return {
    canRead: canReadDirectory || canReadWorkspaces,
    canWrite,
    canReadDirectory,
    canReadWorkspaces,
  };
}

export function UsersPage({ model }: UsersPageProps) {
  const capabilityState = usersPageCapabilityState(model.authorization);

  return (
    <OpsPage
      eyebrow="PLATFORM GOVERNANCE"
      title="用户中心"
      description="集中管理用户、企业和授权；详细账务、审计与风险信息在用户详情中查看。"
      actions={<Button type="primary" disabled={!capabilityState.canRead} loading={model.loading} title={!capabilityState.canRead ? "当前会话没有用户治理读取能力" : undefined} onClick={() => void model.load()}>刷新目录</Button>}
    >
      <div className="ops-users-page">
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <UsersGovernanceWorkspace model={model} onRefresh={() => void model.load()} />
      </div>
    </OpsPage>
  );
}
