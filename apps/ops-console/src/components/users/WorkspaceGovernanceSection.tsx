import { useState } from "react";
import { Button, Card, Descriptions, Form, Input, Select, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { WorkspaceSummary } from "../../types/ops";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";

const subscriptionLabels: Record<string, string> = { active: "订阅中", trialing: "试用中", inactive: "未订阅", canceled: "已取消" };

export function WorkspaceGovernanceSection({ model }: { model: OpsConsoleModel }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">();
  const [target, setTarget] = useState<WorkspaceSummary>();
  const rows = model.workspaceRows.filter((row) => {
    const keyword = query.trim().toLowerCase();
    return (!keyword || `${row.enterpriseName ?? ""} ${row.workspaceId} ${row.planName}`.toLowerCase().includes(keyword)) && (!status || row.status === status);
  });
  return <>
    <Card title="用户月费详情" extra={<Typography.Text type="secondary">共 {rows.length} 个工作区</Typography.Text>}>
      <Form layout="inline" style={{ marginBottom: 16 }} onFinish={() => void model.loadWorkspaceDirectory({ query: query.trim() || undefined, status, merchantOnly: true, page: 1, pageSize: model.workspaceDirectory.limit })}>
        <Form.Item label="搜索"><Input allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="用户名或店铺名" style={{ width: 240 }} /></Form.Item>
        <Form.Item label="状态"><Select allowClear value={status} onChange={setStatus} placeholder="全部" options={[{ label: "正常", value: "active" }, { label: "已停用", value: "disabled" }]} style={{ width: 140 }} /></Form.Item>
        <Space><Button type="primary" htmlType="submit" loading={model.workspaceDirectoryLoading}>查询</Button><Button onClick={() => void model.loadWorkspaceDirectory({ query: query.trim() || undefined, status, merchantOnly: true, page: 1, pageSize: model.workspaceDirectory.limit })} loading={model.workspaceDirectoryLoading}>刷新列表</Button></Space>
      </Form>
      <Table<WorkspaceSummary> rowKey="workspaceId" loading={model.workspaceDirectoryLoading} dataSource={rows} locale={{ emptyText: "暂无月费工作区记录" }} pagination={{ pageSize: model.workspaceDirectory.limit, showTotal: (total) => `共 ${total} 条记录` }} scroll={{ x: 900 }} columns={[
        { title: "用户 / 企业主体", key: "enterprise", width: 260, render: (_: unknown, row) => <EnterpriseIdentity name={row.enterpriseName} workspaceId={row.workspaceId} /> },
        { title: "套餐", dataIndex: "planName", width: 160 },
        { title: "月费", dataIndex: "monthlyPriceCny", width: 110, render: (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}` },
        { title: "订阅状态", dataIndex: "subscriptionStatus", width: 120, render: (value: string) => <Tag color={value === "active" ? "green" : value === "trialing" ? "blue" : "default"}>{subscriptionLabels[value] ?? value}</Tag> },
        { title: "任务用量", width: 120, render: (_: unknown, row) => `${row.usedTasks} / ${row.includedTasks}` },
        { title: "成员", dataIndex: "memberCount", width: 80 },
        { title: "操作", key: "action", width: 100, render: (_: unknown, row) => <Button size="small" onClick={() => setTarget(row)}>详情</Button> },
      ]} />
    </Card>
    <Card size="small" style={{ marginTop: 12 }}><Typography.Text type="secondary">月费详情沿用接入详情的用户/工作区主表逻辑；企业主体停用、恢复等治理操作请在治理页面处理。</Typography.Text></Card>
    {target ? <div className="ops-modal-overlay" role="presentation" onClick={() => setTarget(undefined)}><div className="ops-modal-card" role="dialog" aria-modal="true" aria-label="月费详情" onClick={(event) => event.stopPropagation()}><div className="ops-modal-card-header"><strong>月费详情</strong><Button type="text" onClick={() => setTarget(undefined)}>关闭</Button></div><Descriptions column={1} size="small"><Descriptions.Item label="企业主体"><EnterpriseIdentity name={target.enterpriseName} workspaceId={target.workspaceId} /></Descriptions.Item><Descriptions.Item label="套餐">{target.planName}</Descriptions.Item><Descriptions.Item label="月费">¥{target.monthlyPriceCny.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}</Descriptions.Item><Descriptions.Item label="订阅状态">{subscriptionLabels[target.subscriptionStatus] ?? target.subscriptionStatus}</Descriptions.Item><Descriptions.Item label="任务用量">{target.usedTasks} / {target.includedTasks}</Descriptions.Item><Descriptions.Item label="成员">{target.memberCount}</Descriptions.Item></Descriptions></div></div> : null}
  </>;
}
