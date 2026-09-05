import { Button } from "antd";
import { MembersSection } from "../components/finance/MembersSection";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface MembersPageProps {
  model: OpsConsoleModel;
}

export function MembersPage({ model }: MembersPageProps) {
  const canReadMembers = Boolean(model.opsSession?.workspace_id) && model.authorization.can("workspace.member.read");
  return (
    <OpsPage
      eyebrow="ACCESS GOVERNANCE"
      title="成员与权限"
      description="在当前租户范围内邀请成员、调整角色和停用访问；所有变更均要求原因并进入审计记录。"
      actions={<Button type="primary" disabled={!canReadMembers} loading={model.loading} title={!canReadMembers ? "当前会话没有成员读取能力或尚未选择工作区" : undefined} onClick={() => void model.load()}>刷新成员</Button>}
    >
      <MembersSection model={model} />
    </OpsPage>
  );
}
