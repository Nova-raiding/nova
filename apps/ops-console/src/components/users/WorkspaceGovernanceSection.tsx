import { useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { commercialOperationsClient, type CommercialEntitlement, type CommercialOperationsClient } from "../../api/commercialOperationsClient.js";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { WorkspaceSummary } from "../../types/ops";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";
import { OpsPageError } from "../OpsPageError.js";
import { packageDisplayName } from "../commercial/packageLabels.js";

const subscriptionLabels: Record<string, string> = { active: "订阅中", trialing: "试用中", inactive: "未订阅", canceled: "已取消" };
const entitlementLabels: Record<string, string> = { active: "生效中", expired: "已到期", canceled: "已取消", blocked: "不可执行", pending: "待生效" };

function WorkspaceEntitlementFacts({ workspaceId, canRead, client }: { workspaceId: string; canRead: boolean; client: Pick<CommercialOperationsClient, "entitlements"> }) {
  const [state, setState] = useState<{ loading: boolean; items: CommercialEntitlement[]; total: number; incomplete: boolean; error: string }>({ loading: canRead, items: [], total: 0, incomplete: false, error: "" });
  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    void client.entitlements(workspaceId, { limit: 20 }, controller.signal).then(page => {
      if (!controller.signal.aborted) setState({ loading: false, items: page.items, total: page.total, incomplete: Boolean(page.truncated || page.nextCursor || page.total > page.items.length), error: "" });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ loading: false, items: [], total: 0, incomplete: false, error: error instanceof Error ? error.message : "权益读取失败" });
    });
    return () => controller.abort();
  }, [workspaceId, canRead, client]);
  return <section aria-label="V2 权益快照" style={{ marginTop: 16 }}>
    <Typography.Title level={5}>V2 权益快照（服务端）</Typography.Title>
    {!canRead ? <Alert type="warning" showIcon title="当前角色无权益读取权限，无法核对实际开通状态。" />
      : state.loading ? <Typography.Text>正在读取权益记录…</Typography.Text>
        : state.error ? <Alert type="error" showIcon title="权益读取失败，实际开通状态未知" description={state.error} />
          : state.items.length === 0 ? <Alert type="info" showIcon title="未找到 V2 权益快照，实际开通状态需要核对。" />
            : <>
              <Typography.Text type="secondary">最近 {state.items.length} 条，共 {state.total} 条。状态由服务端权益记录给出；订单支付和权益发放仍需分别核对。</Typography.Text>
              {state.items.map(item => <Descriptions key={item.id} column={1} size="small" bordered style={{ marginTop: 10 }}>
                <Descriptions.Item label="套餐">{packageDisplayName(item.skuCode)}（{item.skuCode}）</Descriptions.Item>
                <Descriptions.Item label="权益状态"><Tag color={item.status === "active" ? "green" : item.status === "blocked" ? "red" : "default"}>{entitlementLabels[item.status] ?? item.status}</Tag></Descriptions.Item>
                <Descriptions.Item label="服务期间">{item.periodLabel ?? "未提供"}</Descriptions.Item>
                <Descriptions.Item label="权益 ID"><Typography.Text code copyable>{item.id}</Typography.Text></Descriptions.Item>
              </Descriptions>)}
              {state.incomplete ? <Alert type="warning" showIcon title="这里只显示前 20 条，请到「账务与退款」查看完整权益记录。" style={{ marginTop: 10 }} /> : null}
            </>}
  </section>;
}

export function workspaceDirectoryPageRequest(query: string, status: "active" | "disabled" | undefined, page: number, pageSize: number) {
  return { query: query.trim() || undefined, status, merchantOnly: true, page, pageSize };
}

export function WorkspaceGovernanceSection({ model, entitlementClient = commercialOperationsClient }: { model: OpsConsoleModel; entitlementClient?: Pick<CommercialOperationsClient, "entitlements"> }) {
  const canUpdateWorkspaceStatus = model.authorization.can("workspace.status.update");
  const canReadEntitlements = model.authorization.can("commercial.entitlement.read");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">();
  const [statusTarget, setStatusTarget] = useState<WorkspaceSummary>();
  const [detailTarget, setDetailTarget] = useState<WorkspaceSummary>();
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
  const changingTo = statusTarget?.status === "active" ? "disabled" : "active";
  const reasonMinimum = changingTo === "disabled" ? 4 : 1;
  const close = () => { if (!submitting) { setStatusTarget(undefined); setReason(""); } };
  const submitStatusChange = async () => {
    if (!statusTarget || reason.trim().length < reasonMinimum) return;
    setSubmitting(true);
    const saved = await model.changeWorkspaceStatus(statusTarget.workspaceId, changingTo, reason.trim());
    setSubmitting(false);
    if (saved) {
      setStatusTarget(undefined);
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
        { title: "旧版套餐快照", dataIndex: "planName", width: 160 },
        { title: "旧版标价（元/月）", dataIndex: "monthlyPriceCny", width: 145, render: (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}` },
        { title: "旧版订阅状态", dataIndex: "subscriptionStatus", width: 120, render: (value: string) => <Tag color={value === "active" ? "green" : value === "trialing" ? "blue" : "default"}>{subscriptionLabels[value] ?? value}</Tag> },
        { title: "旧版任务用量", width: 120, render: (_: unknown, row) => `${row.usedTasks} / ${row.includedTasks}` },
        { title: "成员", dataIndex: "memberCount", width: 80 },
        { title: "操作", key: "action", width: 100, render: (_: unknown, row) => <Button size="small" onClick={() => setDetailTarget(row)}>详情</Button> },
        { title: "治理", key: "governance", width: 130, render: (_: unknown, row) => <Button size="small" danger={row.status === "active"} disabled={!canUpdateWorkspaceStatus || (row.status === "active" && row.workspaceId === model.opsSession?.workspace_id)} title={row.status === "active" && row.workspaceId === model.opsSession?.workspace_id ? "不能从当前路由工作区停用自身" : !canUpdateWorkspaceStatus ? "当前角色只有租户目录读取权限" : undefined} onClick={() => { setReason(""); setStatusTarget(row); }}>{row.status === "active" ? "停用租户" : "恢复租户"}</Button> },
      ]} />
    </Card>
    <Typography.Text type="secondary">本表套餐、标价、订阅状态和任务用量均为旧版工作区快照；当前已付订单与成长版权益请到「账务与退款」及当前权益记录核对，不能从旧版“试用中”判断付款失败。</Typography.Text>
    <Modal title={changingTo === "disabled" ? "停用租户" : "恢复租户"} open={Boolean(statusTarget)} okText={changingTo === "disabled" ? "确认停用" : "确认恢复"} confirmLoading={submitting} okButtonProps={{ danger: changingTo === "disabled", disabled: reason.trim().length < reasonMinimum }} onCancel={close} onOk={() => void submitStatusChange()}>
      <Space orientation="vertical" className="full-width">
        <Typography.Paragraph>目标租户：<Typography.Text code>{statusTarget?.workspaceId}</Typography.Text></Typography.Paragraph>
        <Alert showIcon type={changingTo === "disabled" ? "warning" : "info"} title={changingTo === "disabled" ? "停用后该租户成员将无法继续访问；数据和审计记录会保留。" : "恢复后成员仍需使用有效身份和会话重新访问。"} />
        <label htmlFor="workspace-status-reason">操作原因{changingTo === "disabled" ? "（至少 4 个字符）" : "（必填）"}</label>
        <Input.TextArea id="workspace-status-reason" autoFocus rows={4} maxLength={500} showCount value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写工单号、风险证据或客户请求" />
      </Space>
    </Modal>
    {detailTarget ? <div className="ops-modal-overlay" role="presentation" onClick={() => setDetailTarget(undefined)}><div className="ops-modal-card" role="dialog" aria-modal="true" aria-label="工作区详情" style={{ width: "min(680px, 100%)", maxHeight: "85vh", overflowY: "auto" }} onClick={(event) => event.stopPropagation()}><div className="ops-modal-card-header"><strong>工作区详情</strong><Button type="text" onClick={() => setDetailTarget(undefined)}>关闭</Button></div><Descriptions column={1} size="small"><Descriptions.Item label="企业主体"><EnterpriseIdentity name={detailTarget.enterpriseName} workspaceId={detailTarget.workspaceId} /></Descriptions.Item><Descriptions.Item label="旧版套餐快照">{detailTarget.planName}</Descriptions.Item><Descriptions.Item label="旧版标价（元/月）">¥{detailTarget.monthlyPriceCny.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}</Descriptions.Item><Descriptions.Item label="旧版订阅状态">{subscriptionLabels[detailTarget.subscriptionStatus] ?? detailTarget.subscriptionStatus}</Descriptions.Item><Descriptions.Item label="企业状态">{detailTarget.status === "active" ? "正常" : "已停用"}</Descriptions.Item><Descriptions.Item label="旧版任务用量">{detailTarget.usedTasks} / {detailTarget.includedTasks}</Descriptions.Item><Descriptions.Item label="成员">{detailTarget.memberCount}</Descriptions.Item></Descriptions><WorkspaceEntitlementFacts workspaceId={detailTarget.workspaceId} canRead={canReadEntitlements} client={entitlementClient} /></div></div> : null}
  </>;
}
