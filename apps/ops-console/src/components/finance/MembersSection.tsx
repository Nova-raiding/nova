import { Alert, Button, Card, Form, Input, Select, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

interface MembersSectionProps {
  model: OpsConsoleModel;
}

export function MembersSection({ model }: MembersSectionProps) {
  const { memberForm, saveMember, canMembers, members, opsSession } = model;
  const roleLabels: Record<string, string> = { workspace_owner: "工作区所有者", merchant_admin: "商家管理员", operator: "运营", support: "支持", finance: "财务", platform_ops: "平台运营" };
  const canAssignOwner = model.canUserGovernance || Boolean(opsSession?.roles.includes("workspace_owner"));
  const assignableRoles = Object.entries(roleLabels).filter(([role]) => (role !== "platform_ops" || model.canUserGovernance) && (role !== "workspace_owner" || canAssignOwner));
  const statusLabels: Record<string, string> = { active: "已激活", invited: "待激活", suspended: "已停用" };

  return (
    <Card title="当前租户成员" extra={<Typography.Text type="secondary">{opsSession?.workspace_id ?? "当前工作区"}</Typography.Text>}>
      <Space orientation="vertical" size="middle" className="full-width">
        {!canMembers && <Alert showIcon type="info" title="当前角色只有成员查看权限" description="只有工作区所有者或平台运营可以新增成员和调整角色。" />}
        <Form form={memberForm} layout="inline" onFinish={saveMember} onFinishFailed={({ errorFields }) => { const first = errorFields[0]?.name; if (first) memberForm.scrollToField(first, { block: "center", focus: true }); }} disabled={!canMembers} aria-label="当前租户成员编辑">
          <Form.Item name="externalSubject" label="用户 ID" rules={[{ required: true, message: "请输入用户 ID" }]}>
            <Input placeholder="例如 user_123" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名">
            <Input placeholder="用户姓名或称呼" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
          <Select placeholder="请选择角色" style={{ width: 180 }} options={assignableRoles.map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item><Button disabled={!canMembers} type="primary" htmlType="submit">保存成员</Button></Form.Item>
        </Form>
        <Table
          rowKey="id"
          size="small"
          pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 位成员` }}
          dataSource={members}
          locale={{ emptyText: "当前租户还没有成员" }}
          scroll={{ x: 720 }}
          columns={[
            { title: "身份标识", dataIndex: "externalSubject", width: 180 },
            { title: "显示名", dataIndex: "displayName", width: 150, render: (value: string) => value || "—" },
            { title: "角色", dataIndex: "role", width: 150, render: (value: string) => <Tag color="blue">{roleLabels[value] ?? value}</Tag> },
            { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "active" ? "green" : value === "suspended" ? "red" : "gold"}>{statusLabels[value] ?? value}</Tag> },
            { title: "更新时间", dataIndex: "updatedAt", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
          ]}
        />
      </Space>
    </Card>
  );
}
