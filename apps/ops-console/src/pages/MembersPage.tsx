import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import { MembersSection } from "../components/finance/MembersSection";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface MembersPageProps {
  model: OpsConsoleModel;
}

export function MembersPage({ model }: MembersPageProps) {
  const canReadMembers = Boolean(model.opsSession?.workspace_id) && model.authorization.can("workspace.member.read");
  const capabilities = model.opsSession?.capabilities ?? [];
  return (
    <OpsPage
      eyebrow="ACCESS GOVERNANCE"
      title="成员与权限"
      description="在当前租户范围内邀请成员、调整角色和停用访问；所有变更均要求原因并进入审计记录。"
      actions={<Button type="primary" disabled={!canReadMembers} loading={model.loading} title={!canReadMembers ? "当前会话没有成员读取能力或尚未选择工作区" : undefined} onClick={() => void model.load()}>刷新成员</Button>}
    >
      <Card title="当前账号权限" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={8} className="full-width">
          <Typography.Text>
            当前账号：<Typography.Text strong>{model.opsSession?.actor_id ?? "未验证"}</Typography.Text>
            <Tag color="blue" style={{ marginLeft: 8 }}>{model.opsSession?.roles?.[0] ?? "未返回角色"}</Tag>
          </Typography.Text>
          {capabilities.length ? (
            <Space wrap size={[6, 6]} aria-label="当前账号能力列表">
              {capabilities.map((capability) => <Tag key={capability} color={capability.includes("update") || capability.includes("execute") || capability.includes("manage") ? "green" : "blue"}>{capability}</Tag>)}
            </Space>
          ) : (
            <Alert showIcon type="warning" title="服务端尚未返回权限投影" description="当前页面会按 fail-closed 处理，不能仅凭角色名称推断权限；请刷新会话或检查运营 API。" />
          )}
          <Typography.Text type="secondary">权限来自当前工作区服务端会话，不能在浏览器端自行添加；知识库读取需要 customer.content.read。</Typography.Text>
        </Space>
      </Card>
      <MembersSection model={model} />
    </OpsPage>
  );
}
