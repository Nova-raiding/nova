import { useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { WorkspaceSummary } from "../../types/ops";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";
import { OpsPageError } from "../OpsPageError.js";

const subscriptionLabels: Record<string, string> = { active: "订阅中", trialing: "试用中", inactive: "未订阅", canceled: "已取消" };

export function workspaceDirectoryPageRequest(query: string, status: "active" | "disabled" | undefined, page: number, pageSize: number) {
  return { query: query.trim() || undefined, status, merchantOnly: true, page, pageSize };
}

export function WorkspaceGovernanceSection({ model }: { model: OpsConsoleModel }) {
  const canUpdateWorkspaceStatus = model.authorization.can("workspace.status.update");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">();
  const [target, setTarget] = useState<WorkspaceSummary>();
  const page = Math.floor(model.workspaceDirectory.offset / model.workspaceDirectory.limit) + 1;
  const rows = model.workspaceDirectory.items;
  // `workspaceRows` starts empty and keeps the last successful page, so an
  // unread directory and a directory the server answered with nothing rendered
  // the same 「共 0 个工作区」 + 「暂无月费工作区记录」. The manual refresh records its
  // failure in `workspaceDirectoryError`; the console-wide bootstrap records
  // `ops.workspaces.list` in the shared dataset errors.
  const directoryError = model.workspaceDirectoryError || model.dataSetError("ops.workspaces.list") || "";
  const loadPage = (nextPage: number) => model.loadWorkspaceDirectory(workspaceDirectoryPageRequest(query, status, nextPage, model.workspaceDirectory.limit));
  const reloadDirectory = () => void loadPage(page);
  const changingTo = target?.status === "active" ? "disabled" : "active";
  const reasonMinimum = changingTo === "disabled" ? 4 : 1;
  const close = () => { if (!submitting) { setTarget(undefined); setReason(""); } };
  const submitStatusChange = async () => {
    if (!target || reason.trim().length < reasonMinimum) return;
    setSubmitting(true);
    const saved = await model.changeWorkspaceStatus(target.workspaceId, changingTo, reason.trim());
    setSubmitting(false);
    if (saved) {
      setTarget(undefined);
      setReason("");
      await loadPage(page);
    }
  };
  return <>
    <Card title="商家工作区与套餐" extra={<Typography.Text type="secondary">{directoryError ? "工作区数量未知：目录读取失败" : `共 ${model.workspaceDirectory.total} 个工作区`}</Typography.Text>}>
      <Form layout="inline" style={{ marginBottom: 16 }} onFinish={() => void loadPage(1)}>
        <Form.Item label="搜索"><Input allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="企业名称 / 工作区 ID / 套餐" style={{ width: 280 }} /></Form.Item>
        <Form.Item label="状态"><Select allowClear value={status} onChange={setStatus} placeholder="全部" options={[{ label: "正常", value: "active" }, { label: "已停用", value: "disabled" }]} style={{ width: 140 }} /></Form.Item>
        <Space><Button type="primary" htmlType="submit" loading={model.workspaceDirectoryLoading}>查询</Button><Button onClick={reloadDirectory} loading={model.workspaceDirectoryLoading}>刷新列表</Button></Space>
      </Form>
      <OpsPageError error={directoryError} onRetry={reloadDirectory} />
      <Table<WorkspaceSummary> rowKey="workspaceId" loading={model.workspaceDirectoryLoading} dataSource={rows} locale={{ emptyText: directoryError ? "工作区读取失败，这不是空列表：请查看上方错误摘要后重试。" : "暂无商家工作区记录" }} pagination={{ current: page, pageSize: model.workspaceDirectory.limit, total: model.workspaceDirectory.total, showSizeChanger: false, showTotal: (total) => `共 ${total} 条记录`, onChange: (nextPage) => void loadPage(nextPage) }} scroll={{ x: 980 }} columns={[
        { title: "用户 / 企业主体", key: "enterprise", width: 260, render: (_: unknown, row) => <EnterpriseIdentity name={row.enterpriseName} workspaceId={row.workspaceId} /> },
        { title: "套餐", dataIndex: "planName", width: 160 },
        { title: "套餐标价（元/月）", dataIndex: "monthlyPriceCny", width: 145, render: (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}` },
        { title: "订阅状态", dataIndex: "subscriptionStatus", width: 120, render: (value: string) => <Tag color={value === "active" ? "green" : value === "trialing" ? "blue" : "default"}>{subscriptionLabels[value] ?? value}</Tag> },
        { title: "任务用量", width: 120, render: (_: unknown, row) => `${row.usedTasks} / ${row.includedTasks}` },
        { title: "成员", dataIndex: "memberCount", width: 80 },
        { title: "操作", key: "action", width: 100, render: (_: unknown, row) => <Button size="small" onClick={() => setTarget(row)}>详情</Button> },
        { title: "治理", key: "governance", width: 130, render: (_: unknown, row) => <Button size="small" danger={row.status === "active"} disabled={!canUpdateWorkspaceStatus || (row.status === "active" && row.workspaceId === model.opsSession?.workspace_id)} title={row.status === "active" && row.workspaceId === model.opsSession?.workspace_id ? "不能从当前路由工作区停用自身" : !canUpdateWorkspaceStatus ? "当前角色只有租户目录读取权限" : undefined} onClick={() => { setReason(""); setTarget(row); }}>{row.status === "active" ? "停用租户" : "恢复租户"}</Button> },
      ]} />
    </Card>
    <Typography.Text type="secondary">套餐标价来自工作区配置，实际收款以账务流水为准；未订阅不代表已支付月费。</Typography.Text>
    <Modal title={changingTo === "disabled" ? "停用租户" : "恢复租户"} open={Boolean(target)} okText={changingTo === "disabled" ? "确认停用" : "确认恢复"} confirmLoading={submitting} okButtonProps={{ danger: changingTo === "disabled", disabled: reason.trim().length < reasonMinimum }} onCancel={close} onOk={() => void submitStatusChange()}>
      <Space orientation="vertical" className="full-width">
        <Typography.Paragraph>目标租户：<Typography.Text code>{target?.workspaceId}</Typography.Text></Typography.Paragraph>
        <Alert showIcon type={changingTo === "disabled" ? "warning" : "info"} title={changingTo === "disabled" ? "停用后该租户成员将无法继续访问；数据和审计记录会保留。" : "恢复后成员仍需使用有效身份和会话重新访问。"} />
        <label htmlFor="workspace-status-reason">操作原因{changingTo === "disabled" ? "（至少 4 个字符）" : "（必填）"}</label>
        <Input.TextArea id="workspace-status-reason" autoFocus rows={4} maxLength={500} showCount value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写工单号、风险证据或客户请求" />
      </Space>
    </Modal>
    {target ? <div className="ops-modal-overlay" role="presentation" onClick={() => setTarget(undefined)}><div className="ops-modal-card" role="dialog" aria-modal="true" aria-label="工作区详情" onClick={(event) => event.stopPropagation()}><div className="ops-modal-card-header"><strong>工作区详情</strong><Button type="text" onClick={() => setTarget(undefined)}>关闭</Button></div><Descriptions column={1} size="small"><Descriptions.Item label="企业主体"><EnterpriseIdentity name={target.enterpriseName} workspaceId={target.workspaceId} /></Descriptions.Item><Descriptions.Item label="套餐">{target.planName}</Descriptions.Item><Descriptions.Item label="套餐标价（元/月）">¥{target.monthlyPriceCny.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}</Descriptions.Item><Descriptions.Item label="订阅状态">{subscriptionLabels[target.subscriptionStatus] ?? target.subscriptionStatus}</Descriptions.Item><Descriptions.Item label="企业状态">{target.status === "active" ? "正常" : "已停用"}</Descriptions.Item><Descriptions.Item label="任务用量">{target.usedTasks} / {target.includedTasks}</Descriptions.Item><Descriptions.Item label="成员">{target.memberCount}</Descriptions.Item></Descriptions></div></div> : null}
  </>;
}
