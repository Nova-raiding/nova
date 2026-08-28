import { UserDirectorySection } from "../components/users/UserDirectorySection";
import { MembersSection } from "../components/finance/MembersSection";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface UsersPageProps {
  model: OpsConsoleModel;
}

export function UsersPage({ model }: UsersPageProps) {
  return (
    <OpsPage
      eyebrow="PLATFORM GOVERNANCE"
      title="用户与租户"
      description="跨工作区查询用户身份和成员关系，定位账号状态并执行可审计的访问停用。"
    >
      <OpsPageError error={model.userDirectoryError} onRetry={() => void model.loadUsers()} />
      <UserDirectorySection model={model} />
      <MembersSection model={model} />
    </OpsPage>
  );
}
