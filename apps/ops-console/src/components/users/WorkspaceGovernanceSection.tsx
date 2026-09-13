import { useState } from "react";
import { Alert, Button, Card, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { WorkspaceSummary } from "../../types/ops";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";

export function WorkspaceGovernanceSection({ model }: { model: OpsConsoleModel }) {
  const canUpdateWorkspaceStatus = model.authorization.can("workspace.status.update");
  const [target, setTarget] = useState<WorkspaceSummary>();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "disabled" | undefined>();
  const [merchantOnly, setMerchantOnly] = useState(true);
  const currentWorkspaceId = model.opsSession?.workspace_id;
  const changingTo = target?.status === "active" ? "disabled" : "active";
  const reasonMinimum = changingTo === "disabled" ? 4 : 1;
  const unactivatedWorkspaceCount = model.workspaceDirectory.merchantWorkspaceCount === undefined
    ? undefined
    : Math.max(0, model.workspaceDirectory.total - model.workspaceDirectory.merchantWorkspaceCount);
  const close = () => { if (!submitting) { setTarget(undefined); setReason(""); } };
  const submit = async () => {
    if (!target || reason.trim().length < reasonMinimum) return;
    setSubmitting(true);
    const saved = await model.changeWorkspaceStatus(target.workspaceId, changingTo, reason.trim());
    setSubmitting(false);
    if (saved) close();
  };

  return <>
    <Card title="企业主体治理" extra={<Tag color="blue">仅 platform_ops</Tag>}>
      <Space wrap style={{ margin: "16px 0" }}>
        <Input.Search allowClear value={query} onChange={(event) => setQuery(event.target.value)} onSearch={() => void model.loadWorkspaceDirectory({ query, status, merchantOnly, page: 1, pageSize: model.workspaceDirectory.limit })} placeholder="搜索企业名称、Workspace ID 或套餐" style={{ width: 300 }} />
        <Select allowClear value={status} onChange={(value) => { setStatus(value); void model.loadWorkspaceDirectory({ query, status: value, merchantOnly, page: 1, pageSize: model.workspaceDirectory.limit }); }} placeholder="工作区状态" options={[{ label: "正常", value: "active" }, { label: "已停用", value: "disabled" }]} style={{ width: 140 }} />
        <Button type={merchantOnly ? "primary" : "default"} onClick={() => { const next = !merchantOnly; setMerchantOnly(next); void model.loadWorkspaceDirectory({ query, status, merchantOnly: next, page: 1, pageSize: model.workspaceDirectory.limit }); }}>{merchantOnly ? "仅已开通商家" : "全部工作区记录"}</Button>
        <Typography.Text type="secondary">
          已加载 {model.workspaceRows.length} / 共 {model.workspaceDirectory.total} 条工作区记录
          {model.workspaceDirectory.merchantWorkspaceCount !== undefined ? ` · 已开通 ${model.workspaceDirectory.merchantWorkspaceCount} · 未开通 ${unactivatedWorkspaceCount}` : ""}
        </Typography.Text>
      </Space>
      <Table<WorkspaceSummary>
        rowKey="workspaceId"
        dataSource={model.workspaceRows}
        locale={{ emptyText: "没有可治理的工作区记录；请检查 platform_ops 的平台级授权" }}
        loading={model.workspaceDirectoryLoading}
        pagination={{ current: Math.floor(model.workspaceDirectory.offset / model.workspaceDirectory.limit) + 1, pageSize: model.workspaceDirectory.limit, total: model.workspaceDirectory.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条工作区记录` }}
        onChange={(pagination) => void model.loadWorkspaceDirectory({ query, status, merchantOnly, page: pagination.current, pageSize: pagination.pageSize })}
        scroll={{ x: 900 }}
        columns={[
          { title: "工作区 / 企业主体", key: "enterprise", width: 240, render: (_value: unknown, row: WorkspaceSummary) => <EnterpriseIdentity name={row.enterpriseName} workspaceId={row.workspaceId} /> },
          { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "active" ? "green" : "red"}>{value === "active" ? "正常" : "已停用"}</Tag> },
          { title: "套餐", dataIndex: "planName", width: 140 },
          { title: "订阅", dataIndex: "subscriptionStatus", width: 120 },
          { title: "任务用量", width: 120, render: (_: unknown, row: WorkspaceSummary) => `${row.usedTasks} / ${row.includedTasks}` },
          { title: "成员", dataIndex: "memberCount", width: 80 },
          { title: "操作", key: "action", fixed: "right", width: 140, render: (_: unknown, row: WorkspaceSummary) => {
            const selfDisable = row.workspaceId === currentWorkspaceId && row.status === "active";
            return <Button size="small" danger={row.status === "active"} disabled={!canUpdateWorkspaceStatus || selfDisable} title={selfDisable ? "不能从当前路由工作区停用自身；请切换到其他运营工作区" : !canUpdateWorkspaceStatus ? "当前角色只有企业主体目录读取权限" : undefined} onClick={() => setTarget(row)}>{row.status === "active" ? "停用企业主体" : "恢复企业主体"}</Button>;
          } },
        ]}
      />
    </Card>
    <Modal title={changingTo === "disabled" ? "停用企业主体" : "恢复企业主体"} open={Boolean(target)} okText={changingTo === "disabled" ? "确认停用" : "确认恢复"} confirmLoading={submitting} okButtonProps={{ danger: changingTo === "disabled", disabled: reason.trim().length < reasonMinimum }} onCancel={close} onOk={() => void submit()}>
      <Space orientation="vertical" className="full-width">
        <Typography.Paragraph>目标企业主体：<EnterpriseIdentity name={target?.enterpriseName} workspaceId={target?.workspaceId} /></Typography.Paragraph>
        <Alert showIcon type={changingTo === "disabled" ? "warning" : "info"} title={changingTo === "disabled" ? "停用后该企业主体成员将无法继续访问；数据和审计记录会保留。" : "恢复后成员仍需使用有效身份和会话重新访问。"} />
        <label htmlFor="workspace-status-reason">操作原因{changingTo === "disabled" ? "（至少 4 个字符）" : "（必填）"}</label>
        <Input.TextArea id="workspace-status-reason" autoFocus rows={4} maxLength={500} showCount status={reason.length > 0 && reason.trim().length < reasonMinimum ? "error" : undefined} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写工单号、风险证据或客户请求" />
      </Space>
    </Modal>
  </>;
}
