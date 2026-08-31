import { Alert, Button, Card, Form, Grid, Input, Modal, Select, Space, Spin, Table, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { createMembersClient, memberCapabilities, useMembers, type MemberRole, type MembersClient, type WorkspaceMember } from "../../hooks/useMembers.js";

interface MembersSectionProps {
  model: OpsConsoleModel;
  client?: MembersClient;
}

type PendingAction =
  | { kind: "role"; member: WorkspaceMember; role: MemberRole }
  | { kind: "deactivate" | "reactivate"; member: WorkspaceMember };

const roleLabels: Record<MemberRole, string> = {
  workspace_owner: "工作区所有者",
  merchant_admin: "商家管理员",
  operator: "运营",
  support: "支持",
  finance: "财务",
  platform_ops: "平台运营",
};
const statusLabels = { active: "已激活", invited: "待激活", suspended: "已停用" } as const;

export function MembersSection({ model, client }: MembersSectionProps) {
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const workspaceId = model.opsSession?.workspace_id;
  const actorId = model.opsSession?.actor_id;
  const stableClient = useMemo(() => client ?? createMembersClient(), [client]);
  const state = useMembers(workspaceId, stableClient);
  const [inviteForm] = Form.useForm();
  const [actionForm] = Form.useForm();
  const [pending, setPending] = useState<PendingAction>();
  const [notice, setNotice] = useState("");
  const generalCapabilities = memberCapabilities(model.authorization, actorId);
  const initialLoadFailed = Boolean(state.error && !state.loading && state.members.length === 0);
  const assignableRoles = (model.opsSession?.assignable_roles ?? [])
    .filter((role): role is MemberRole => role in roleLabels)
    .map((value) => ({ value, label: roleLabels[value] }));
  const assignmentPolicyUnavailable = generalCapabilities.canManage && model.opsSession?.assignable_roles === undefined;

  const openAction = (action: PendingAction) => {
    setNotice("");
    state.clearError();
    setPending(action);
    actionForm.setFieldsValue({ reason: "", role: action.kind === "role" ? action.role : undefined });
  };
  const closeAction = () => {
    setPending(undefined);
    actionForm.resetFields();
  };
  const submitAction = async () => {
    if (!pending) return;
    const values = await actionForm.validateFields() as { reason: string; role?: MemberRole };
    if (pending.kind === "role") {
      await state.changeRole(pending.member, values.role!, values.reason.trim());
      setNotice(`已更新 ${pending.member.displayName || pending.member.externalSubject} 的角色。`);
    } else if (pending.kind === "deactivate") {
      await state.deactivate(pending.member, values.reason.trim());
      setNotice(`已停用 ${pending.member.displayName || pending.member.externalSubject}。`);
    } else {
      await state.reactivate(pending.member, values.reason.trim());
      setNotice(`已恢复 ${pending.member.displayName || pending.member.externalSubject}。`);
    }
    closeAction();
  };

  const actionButtons = (member: WorkspaceMember) => {
    const capabilities = memberCapabilities(model.authorization, actorId, member);
    if (!capabilities.canChangeTarget) return <Typography.Text type="secondary">只读</Typography.Text>;
    return (
      <Space wrap size={8}>
        <Button style={{ minHeight: 44 }} onClick={() => openAction({ kind: "role", member, role: member.role })} aria-label={`调整 ${member.displayName || member.externalSubject} 的角色`}>改角色</Button>
        {member.status === "suspended" ? (
          <Button style={{ minHeight: 44 }} onClick={() => openAction({ kind: "reactivate", member })} aria-label={`恢复 ${member.displayName || member.externalSubject}`}>恢复</Button>
        ) : (
          <Button danger disabled={!capabilities.canDeactivateTarget} style={{ minHeight: 44 }} onClick={() => openAction({ kind: "deactivate", member })} aria-label={`停用 ${member.displayName || member.externalSubject}`}>{member.externalSubject === actorId ? "不能停用自己" : "停用"}</Button>
        )}
      </Space>
    );
  };

  return (
    <Card title="当前租户成员" extra={<Typography.Text type="secondary" className="ops-token">{workspaceId ?? "未选择工作区"}</Typography.Text>}>
      <Space orientation="vertical" size="middle" className="full-width">
        {!generalCapabilities.canManage && <Alert showIcon type="info" title="当前角色只有成员查看权限" description="只有工作区所有者、商家管理员或平台运营可以邀请成员和调整权限。" />}
        {assignmentPolicyUnavailable && <Alert role="alert" showIcon type="warning" title="成员角色策略尚未取得" description="服务端授权策略未返回前，邀请和角色调整入口保持关闭；请刷新会话后重试。" />}
        {state.error && <Alert role="alert" showIcon type="error" title="成员操作失败" description={<Space orientation="vertical"><span>{state.error}</span><Button onClick={() => void state.load()}>刷新成员</Button></Space>} />}
        {notice && <Alert role="status" aria-live="polite" showIcon type="success" title={notice} closable onClose={() => setNotice("")} />}

        <Form
          form={inviteForm}
          layout={compact ? "vertical" : "inline"}
          disabled={!generalCapabilities.canManage || assignmentPolicyUnavailable || assignableRoles.length === 0 || state.mutating}
          aria-label="邀请工作区成员"
          onFinish={async (values: { externalSubject: string; displayName?: string; role: MemberRole; reason: string }) => {
            setNotice("");
            try {
              await state.invite({ externalSubject: values.externalSubject.trim(), displayName: values.displayName?.trim() ?? "", role: values.role, reason: values.reason.trim() });
              setNotice(`已邀请 ${values.displayName?.trim() || values.externalSubject.trim()}。`);
              inviteForm.resetFields();
            } catch { /* Hook owns the accessible error message. */ }
          }}
          onFinishFailed={({ errorFields }) => {
            const first = errorFields[0]?.name;
            if (first) inviteForm.scrollToField(first, { block: "center", focus: true });
          }}
        >
          <Form.Item name="externalSubject" label="用户 ID" rules={[{ required: true, whitespace: true, message: "请输入用户 ID" }]}>
            <Input autoComplete="off" placeholder="例如 user_123" style={{ minHeight: 44 }} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名"><Input autoComplete="name" placeholder="用户姓名或称呼" style={{ minHeight: 44 }} /></Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
            <Select placeholder={assignmentPolicyUnavailable ? "等待服务端角色策略" : "请选择角色"} style={{ minWidth: compact ? "100%" : 180, minHeight: 44 }} options={assignableRoles} />
          </Form.Item>
          <Form.Item name="reason" label="邀请原因" rules={[{ required: true, whitespace: true, min: 4, message: "请填写至少 4 个字符的邀请原因" }]}>
            <Input placeholder="用于权限审计" style={{ minHeight: 44 }} />
          </Form.Item>
          <Form.Item><Button loading={state.mutating} disabled={!generalCapabilities.canManage || assignmentPolicyUnavailable || assignableRoles.length === 0} style={{ minHeight: 44 }} type="primary" htmlType="submit">邀请成员</Button></Form.Item>
        </Form>

        {compact ? (
          <Spin spinning={state.loading} description="正在加载成员">
            <div role="list" aria-label="成员列表">
              {!state.loading && !state.error && state.members.length === 0 ? <Typography.Text type="secondary">当前租户还没有成员</Typography.Text> : null}
              <Space orientation="vertical" size={12} className="full-width">
                {state.members.map((member) => (
                  <div role="listitem" key={member.id}>
                    <Card size="small">
                      <Space orientation="vertical" size={8} className="full-width">
                        <Typography.Text strong className="ops-token">{member.displayName || member.externalSubject}</Typography.Text>
                        {member.displayName && <Typography.Text type="secondary" className="ops-token">{member.externalSubject}</Typography.Text>}
                        <Space wrap><Tag color="blue">{roleLabels[member.role]}</Tag><Tag color={member.status === "active" ? "green" : member.status === "suspended" ? "red" : "gold"}>{statusLabels[member.status]}</Tag><Typography.Text type="secondary">版本 {member.revision}</Typography.Text></Space>
                        {actionButtons(member)}
                      </Space>
                    </Card>
                  </div>
                ))}
              </Space>
            </div>
          </Spin>
        ) : initialLoadFailed ? (
          <Typography.Text type="secondary" role="status">成员数据尚未取得，请选择工作区后重试；当前状态不能解释为租户没有成员。</Typography.Text>
        ) : (
          <Table<WorkspaceMember>
            aria-label="成员列表"
            rowKey="id"
            loading={state.loading}
            pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 位成员` }}
            dataSource={state.members}
            locale={{ emptyText: "当前租户还没有成员" }}
            scroll={{ x: 960 }}
            columns={[
              { title: "身份标识", dataIndex: "externalSubject", width: 180, render: (value: string) => <span className="ops-token">{value}</span> },
              { title: "显示名", dataIndex: "displayName", width: 150, render: (value: string) => value || "—" },
              { title: "角色", dataIndex: "role", width: 150, render: (value: MemberRole) => <Tag color="blue">{roleLabels[value]}</Tag> },
              { title: "状态", dataIndex: "status", width: 110, render: (value: WorkspaceMember["status"]) => <Tag color={value === "active" ? "green" : value === "suspended" ? "red" : "gold"}>{statusLabels[value]}</Tag> },
              { title: "版本", dataIndex: "revision", width: 80 },
              { title: "更新时间", dataIndex: "updatedAt", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
              { title: "操作", key: "actions", fixed: "right", width: 210, render: (_value, member) => actionButtons(member) },
            ]}
          />
        )}
      </Space>

      <Modal
        open={Boolean(pending)}
        title={pending?.kind === "role" ? "调整成员角色" : pending?.kind === "deactivate" ? "确认停用成员" : "确认恢复成员"}
        okText={pending?.kind === "role" ? "保存角色" : pending?.kind === "deactivate" ? "确认停用" : "确认恢复"}
        cancelText="取消"
        okButtonProps={{ danger: pending?.kind === "deactivate", loading: state.mutating, style: { minHeight: 44 } }}
        cancelButtonProps={{ disabled: state.mutating, style: { minHeight: 44 } }}
        onCancel={closeAction}
        onOk={() => void submitAction().catch(() => undefined)}
        destroyOnHidden
        focusable={{ focusTriggerAfterClose: true }}
      >
        <Typography.Paragraph>{pending ? `${pending.member.displayName || pending.member.externalSubject}（${pending.member.externalSubject}），当前版本 ${pending.member.revision}。` : ""}</Typography.Paragraph>
        <Form form={actionForm} layout="vertical" aria-label="成员变更确认">
          {pending?.kind === "role" && <Form.Item name="role" label="新角色" rules={[{ required: true, message: "请选择新角色" }]}><Select disabled={assignmentPolicyUnavailable || assignableRoles.length === 0} style={{ minHeight: 44 }} options={assignableRoles} /></Form.Item>}
          <Form.Item name="reason" label="变更原因" extra="原因会写入不可变审计记录。" rules={[{ required: true, whitespace: true, min: 4, message: "请填写至少 4 个字符的变更原因" }]}>
            <Input.TextArea autoFocus rows={3} maxLength={500} showCount placeholder="说明业务原因和授权依据" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
