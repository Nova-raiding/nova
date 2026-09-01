import { Alert } from "antd";
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
  const nextStep = !capabilityState.canRead
    ? "当前会话没有用户治理读取能力；请刷新权限投影或切换到已授权的运营工作区。"
    : capabilityState.canWrite
      ? "先确认服务端能力投影与当前工作区范围，再执行需要原因、修订号和审计的治理操作。"
      : "当前是服务端 capability 投影授予的只读视图；需要写入时请申请对应授权。";

  return (
    <OpsPage
      eyebrow="PLATFORM GOVERNANCE"
      title="用户与租户"
      description="按任务管理用户身份、租户状态与平台授权；只展示当前角色可读取的治理区域，所有写入仍由服务端逐次鉴权并审计。"
      nextStep={nextStep}
    >
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <Alert
        showIcon
        type={capabilityState.canRead ? "info" : "warning"}
        role={capabilityState.canRead ? "status" : "alert"}
        aria-live={capabilityState.canRead ? "polite" : "assertive"}
        data-capability-source="server"
        title={capabilityState.canRead ? (capabilityState.canWrite ? "用户治理能力已由服务端确认" : "当前为只读用户治理视图") : "当前会话没有用户治理读取能力"}
        description={capabilityState.canRead
          ? "页面分区、只读状态和写入入口均依据 ops.session 返回的 capability projection；页面不会从角色名称推断权限。"
          : "服务端未授予 identity、租户目录或授权中心读取能力，因此不加载用户治理数据，也不把空结果解释为无数据。"}
      />
      <UsersGovernanceWorkspace model={model} />
    </OpsPage>
  );
}
