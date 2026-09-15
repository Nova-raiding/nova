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
  return (
    <OpsPage
      title="用户中心"
      hideTitle
    >
      <div className="ops-users-page">
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <UsersGovernanceWorkspace model={model} onRefresh={() => void model.load()} />
      </div>
    </OpsPage>
  );
}
