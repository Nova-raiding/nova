import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { UsersGovernanceWorkspace } from "../components/users/UsersGovernanceWorkspace";

interface UsersPageProps {
  model: OpsConsoleModel;
}

export function UsersPage({ model }: UsersPageProps) {
  return (
    <OpsPage
      eyebrow="PLATFORM GOVERNANCE"
      title="用户与租户"
      description="按任务管理用户身份、租户状态与平台授权；只展示当前角色可读取的治理区域，所有写入仍由服务端逐次鉴权并审计。"
    >
      <UsersGovernanceWorkspace model={model} />
    </OpsPage>
  );
}
