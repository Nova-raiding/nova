import { MembersSection } from "../components/finance/MembersSection";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface MembersPageProps {
  model: OpsConsoleModel;
}

export function MembersPage({ model }: MembersPageProps) {
  return (
    <OpsPage
      eyebrow="ACCESS GOVERNANCE"
      title="成员与权限"
      description="在当前租户范围内邀请成员、调整角色和停用访问；所有变更均要求原因并进入审计记录。"
    >
      <MembersSection model={model} />
    </OpsPage>
  );
}
