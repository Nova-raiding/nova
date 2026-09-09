import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import { MembersSection } from "../components/finance/MembersSection";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface MembersPageProps {
  model: OpsConsoleModel;
}

const capabilityLabels: Record<string, string> = {
  "audit.read": "查看审计记录",
  "authorization.session.read": "查看当前登录会话",
  "automation.read": "查看自动化任务",
  "automation.update": "配置自动化任务",
  "billing.export": "导出账务数据",
  "billing.refund.execute": "执行退款",
  "billing.self.read": "查看本人账务",
  "billing.workspace.read": "查看工作区账务",
  "billing.workspace.update": "管理工作区账务",
  "customer.content.read": "查看商家内容与知识库",
  "customer.content.update": "维护商家内容与知识库",
  "customer.publish.execute": "执行商家发布",
  "marketing.queue.read": "查看营销任务队列",
  "marketing.queue.update": "管理营销任务队列",
  "merchant.onboarding.execute": "执行商家入驻引导",
  "model.status.read": "查看模型服务状态",
  "platform.media_spec.read": "查看平台素材规格",
  "rule.read": "查看平台规则",
  "store.connection.read": "查看平台连接",
  "store.connection.update": "管理平台授权连接",
  "workspace.delete.execute": "删除工作区",
  "workspace.member.manage": "管理成员与角色",
  "workspace.member.read": "查看成员",
  "workspace.settings.update": "修改工作区设置",
  "workspace.status.update": "修改工作区状态",
  "workspace.summary.read": "查看工作区概览",
};

const capabilityGroupLabels: Record<string, string> = {
  audit: "审计与安全",
  authorization: "登录与会话",
  automation: "自动化任务",
  billing: "账务与退款",
  customer: "商家内容与知识库",
  marketing: "营销任务",
  merchant: "商家入驻",
  model: "模型服务",
  platform: "平台规则与素材",
  rule: "平台规则",
  store: "平台连接",
  workspace: "工作区与成员",
};

export function capabilityLabel(capability: string) {
  return capabilityLabels[capability] ?? capability
    .split(".")
    .map((part) => part === "read" ? "查看" : part === "update" ? "管理" : part === "execute" ? "执行" : part)
    .join(" · ");
}

export function MembersPage({ model }: MembersPageProps) {
  const canReadMembers = Boolean(model.opsSession?.workspace_id) && model.authorization.can("workspace.member.read");
  const capabilities = model.opsSession?.capabilities ?? [];
  const capabilityGroups = Object.entries(capabilities.reduce<Record<string, string[]>>((groups, capability) => {
    const group = capability.split(".")[0] ?? "other";
    (groups[group] ??= []).push(capability);
    return groups;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
  return (
    <OpsPage
      eyebrow="ACCESS GOVERNANCE"
      title="成员与权限"
      description="在当前租户范围内邀请成员、调整角色和停用访问；所有变更均要求原因并进入审计记录。"
      actions={<Button type="primary" disabled={!canReadMembers} loading={model.loading} title={!canReadMembers ? "当前会话没有成员读取能力或尚未选择工作区" : undefined} onClick={() => void model.load()}>刷新成员</Button>}
    >
      <div className="ops-members-page">
      <Card title="当前账号权限" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={8} className="full-width">
          <Typography.Text>
            当前账号：<Typography.Text strong>{model.opsSession?.actor_id ?? "未验证"}</Typography.Text>
            <Tag color="blue" style={{ marginLeft: 8 }}>{model.opsSession?.roles?.[0] ?? "未返回角色"}</Tag>
          </Typography.Text>
          {capabilities.length ? (
            <div aria-label="当前账号能力列表" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {capabilityGroups.map(([group, items]) => (
                <Card key={group} size="small" title={capabilityGroupLabels[group] ?? "其他权限"} extra={<Tag>{items.length} 项</Tag>} styles={{ body: { padding: 12 } }}>
                  <Space wrap size={[6, 6]}>
                    {items.map((capability) => <Tag key={capability} title={`技术标识：${capability}`} color={capability.includes("update") || capability.includes("execute") || capability.includes("manage") ? "green" : "blue"}>{capabilityLabel(capability)}</Tag>)}
                  </Space>
                </Card>
              ))}
            </div>
          ) : (
            <Alert showIcon type="warning" title="服务端尚未返回权限投影" description="当前页面会按 fail-closed 处理，不能仅凭角色名称推断权限；请刷新会话或检查运营 API。" />
          )}
          <Typography.Text type="secondary">权限来自当前工作区服务端会话，不能在浏览器端自行添加。蓝色表示查看权限，绿色表示管理、执行或变更权限；鼠标悬停可查看技术标识。</Typography.Text>
        </Space>
      </Card>
      <MembersSection model={model} />
      </div>
    </OpsPage>
  );
}
