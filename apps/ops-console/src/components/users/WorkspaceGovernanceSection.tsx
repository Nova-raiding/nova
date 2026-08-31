import { useState } from "react";
import { Alert, Button, Card, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { WorkspaceSummary } from "../../types/ops";

export function WorkspaceGovernanceSection({ model }: { model: OpsConsoleModel }) {
  const canUpdateWorkspaceStatus = model.authorization.can("workspace.status.update");
  const [target, setTarget] = useState<WorkspaceSummary>();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "disabled" | undefined>();
  const currentWorkspaceId = model.opsSession?.workspace_id;
  const changingTo = target?.status === "active" ? "disabled" : "active";
  const reasonMinimum = changingTo === "disabled" ? 4 : 1;
  const close = () => { if (!submitting) { setTarget(undefined); setReason(""); } };
  const submit = async () => {
    if (!target || reason.trim().length < reasonMinimum) return;
    setSubmitting(true);
    const saved = await model.changeWorkspaceStatus(target.workspaceId, changingTo, reason.trim());
    setSubmitting(false);
    if (saved) close();
  };

  return <>
    <Card title="租户治理" extra={<Tag color="blue">仅 platform_ops</Tag>}>
      <Alert className="ops-inline-alert" showIcon type="info" title="停用只阻断访问，不删除业务数据" description="为防止当前运营会话自锁，必须从另一个路由工作区停用目标租户；所有操作写入审计。" />
      <Space wrap style={{ margin: "16px 0" }}>
        <Input.Search allowClear value={query} onChange={(event) => setQuery(event.target.value)} onSearch={() => void model.loadWorkspaceDirectory({ query, status, page: 1, pageSize: model.workspaceDirectory.limit })} placeholder="搜索租户 ID 或套餐" style={{ width: 280 }} />
        <Select allowClear value={status} onChange={(value) => { setStatus(value); void model.loadWorkspaceDirectory({ query, status: value, page: 1, pageSize: model.workspaceDirectory.limit }); }} placeholder="租户状态" options={[{ label: "正常", value: "active" }, { label: "已停用", value: "disabled" }]} style={{ width: 140 }} />
        <Typography.Text type="secondary">已加载 {model.workspaceRows.length} / 共 {model.workspaceDirectory.total} 个租户</Typography.Text>
      </Space>
      <Table<WorkspaceSummary>
        rowKey="workspaceId"
        dataSource={model.workspaceRows}
        locale={{ emptyText: "没有可治理的租户；请检查 platform_ops 的平台级工作区授权" }}
        loading={model.workspaceDirectoryLoading}
        pagination={{ current: Math.floor(model.workspaceDirectory.offset / model.workspaceDirectory.limit) + 1, pageSize: model.workspaceDirectory.limit, total: model.workspaceDirectory.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 个租户` }}
        onChange={(pagination) => void model.loadWorkspaceDirectory({ query, status, page: pagination.current, pageSize: pagination.pageSize })}
        scroll={{ x: 900 }}
        columns={[
          { title: "租户", dataIndex: "workspaceId", width: 200, render: (value: string) => <Typography.Text className="ops-token" copyable>{value}</Typography.Text> },
          { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "active" ? "green" : "red"}>{value === "active" ? "正常" : "已停用"}</Tag> },
          { title: "套餐", dataIndex: "planName", width: 140 },
          { title: "订阅", dataIndex: "subscriptionStatus", width: 120 },
          { title: "任务用量", width: 120, render: (_: unknown, row: WorkspaceSummary) => `${row.usedTasks} / ${row.includedTasks}` },
          { title: "成员", dataIndex: "memberCount", width: 80 },
          { title: "操作", key: "action", fixed: "right", width: 140, render: (_: unknown, row: WorkspaceSummary) => {
            const selfDisable = row.workspaceId === currentWorkspaceId && row.status === "active";
            return <Button size="small" danger={row.status === "active"} disabled={!canUpdateWorkspaceStatus || selfDisable} title={selfDisable ? "不能从当前路由工作区停用自身；请切换到其他运营工作区" : !canUpdateWorkspaceStatus ? "当前角色只有租户目录读取权限" : undefined} onClick={() => setTarget(row)}>{row.status === "active" ? "停用租户" : "恢复租户"}</Button>;
          } },
        ]}
      />
    </Card>
    <Modal title={changingTo === "disabled" ? "停用租户" : "恢复租户"} open={Boolean(target)} okText={changingTo === "disabled" ? "确认停用" : "确认恢复"} confirmLoading={submitting} okButtonProps={{ danger: changingTo === "disabled", disabled: reason.trim().length < reasonMinimum }} onCancel={close} onOk={() => void submit()}>
      <Space orientation="vertical" className="full-width">
        <Typography.Paragraph>目标租户：<Typography.Text code>{target?.workspaceId}</Typography.Text></Typography.Paragraph>
        <Alert showIcon type={changingTo === "disabled" ? "warning" : "info"} title={changingTo === "disabled" ? "停用后该租户成员将无法继续访问；数据和审计记录会保留。" : "恢复后成员仍需使用有效身份和会话重新访问。"} />
        <label htmlFor="workspace-status-reason">操作原因{changingTo === "disabled" ? "（至少 4 个字符）" : "（必填）"}</label>
        <Input.TextArea id="workspace-status-reason" autoFocus rows={4} maxLength={500} showCount status={reason.length > 0 && reason.trim().length < reasonMinimum ? "error" : undefined} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写工单号、风险证据或客户请求" />
      </Space>
    </Modal>
  </>;
}
