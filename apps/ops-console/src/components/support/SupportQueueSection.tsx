import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Empty, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type {
  CreateSupportTicketCommand,
  SupportTicketContract,
  SupportTicketPriority,
  SupportTicketStatus,
} from "../../../../../packages/contracts/src/ops/support.js";
import type { SupportDomainModel } from "../../hooks/useSupportDomain.js";

const statusLabels: Record<SupportTicketStatus, string> = {
  open: "待处理", in_progress: "处理中", waiting_customer: "等待客户", resolved: "已解决", closed: "已关闭",
};
const priorityLabels: Record<SupportTicketPriority, string> = { low: "低", normal: "普通", high: "高", urgent: "紧急" };
const priorityColors: Record<SupportTicketPriority, string> = { low: "default", normal: "blue", high: "orange", urgent: "red" };

type CreateForm = Omit<CreateSupportTicketCommand, "workspaceId" | "idempotencyKey">;

export function SupportQueueSection({ model }: { model: SupportDomainModel }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<CreateForm>();
  const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (model.error) errorRef.current?.focus({ preventScroll: true });
  }, [model.error]);

  const submit = async () => {
    const values = await form.validateFields();
    await model.create({ ...values, tags: values.tags ?? [], idempotencyKey: crypto.randomUUID() });
    form.resetFields();
    setCreateOpen(false);
  };

  return (
    <Card
      title="客服工单队列"
      aria-busy={model.loading}
      extra={<Space wrap>
        <Button icon={<ReloadOutlined aria-hidden="true" />} loading={model.loading} onClick={() => void model.reload()}>刷新</Button>
        <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={initialLoadFailed} title={initialLoadFailed ? "请先修复工作区配置并刷新工单" : undefined} onClick={() => setCreateOpen(true)}>新建工单</Button>
      </Space>}
    >
      <Space wrap aria-label="工单筛选" style={{ marginBottom: 16 }}>
        <Input.Search
          aria-label="搜索工单"
          placeholder="工单号、主题或客户"
          allowClear
          value={model.filters.query}
          onChange={event => model.setFilters({ ...model.filters, query: event.target.value })}
          onSearch={() => void model.reload()}
        />
        <Select
          aria-label="按状态筛选"
          allowClear
          placeholder="全部状态"
          value={model.filters.status}
          style={{ minWidth: 140 }}
          options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
          onChange={status => model.setFilters({ ...model.filters, status })}
        />
        <Select
          aria-label="按优先级筛选"
          allowClear
          placeholder="全部优先级"
          value={model.filters.priority}
          style={{ minWidth: 140 }}
          options={Object.entries(priorityLabels).map(([value, label]) => ({ value, label }))}
          onChange={priority => model.setFilters({ ...model.filters, priority })}
        />
      </Space>
      {model.error ? (
        <div ref={errorRef} tabIndex={-1} role="alert" aria-labelledby="support-queue-error-title" style={{ marginBottom: 16 }}>
          <Alert
            type="error"
            showIcon
            message={<span id="support-queue-error-title">工单队列读取失败</span>}
            description={initialLoadFailed
              ? "当前空列表不代表没有工单；请修复连接或权限后重新加载。"
              : "已保留上一次成功读取的工单，修复连接或权限后可重新加载。"}
            action={<Button htmlType="button" aria-label="刷新工单" style={{ minHeight: 44 }} onClick={() => void model.reload()}>刷新工单</Button>}
          />
        </div>
      ) : null}
      {initialLoadFailed ? (
        <Typography.Text type="secondary" role="status">工单数据尚未取得，当前状态不能解释为没有客服工单。</Typography.Text>
      ) : <Table<SupportTicketContract>
        rowKey="id"
        loading={model.loading}
        pagination={false}
        dataSource={model.tickets}
        locale={{ emptyText: <Empty description="暂无符合条件的客服工单" /> }}
        scroll={{ x: 980 }}
        onRow={ticket => ({
          onClick: () => { if (!ticket.aggregate) void model.selectTicket(ticket.id); },
          onKeyDown: event => { if (!ticket.aggregate && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void model.selectTicket(ticket.id); } },
          tabIndex: 0,
          role: "button",
          "aria-label": `打开工单 ${ticket.ticketNumber} ${ticket.subject}`,
        })}
        columns={[
          { title: "工单", dataIndex: "ticketNumber", fixed: "left", width: 190, render: (value, ticket) => <Space orientation="vertical" size={0}><Typography.Text strong>{value}</Typography.Text><Typography.Text type="secondary">{ticket.subject}</Typography.Text></Space> },
          { title: "客户", width: 180, render: (_, ticket) => <Space orientation="vertical" size={0}><span>{ticket.aggregate ? "平台聚合" : ticket.customerName}</span><Typography.Text type="secondary">{ticket.aggregate ? `${ticket.count ?? 0} 条` : ticket.customerId}</Typography.Text></Space> },
          { title: "状态", dataIndex: "status", width: 120, render: value => <Tag>{statusLabels[value as SupportTicketStatus]}</Tag> },
          { title: "优先级", dataIndex: "priority", width: 100, render: value => <Tag color={priorityColors[value as SupportTicketPriority]}>{priorityLabels[value as SupportTicketPriority]}</Tag> },
          { title: "负责人", dataIndex: "assignedTo", width: 160, render: value => value || "未分配" },
          { title: "创建时间", dataIndex: "createdAt", width: 190, render: value => new Date(String(value)).toLocaleString() },
        ]}
      />}
      {model.hasMore && <Button block loading={model.loadingMore} onClick={() => void model.loadMore()} style={{ marginTop: 16 }}>加载更多工单</Button>}

      <Modal
        title="新建客服工单"
        open={createOpen}
        confirmLoading={model.mutating}
        okText="创建工单"
        cancelText="取消"
        onOk={() => void submit().catch(() => undefined)}
        onCancel={() => setCreateOpen(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ priority: "normal", tags: [] }} requiredMark="optional">
          <Form.Item name="subject" label="主题" rules={[{ required: true, min: 3, max: 200 }]}><Input autoFocus maxLength={200} /></Form.Item>
          <Form.Item name="description" label="问题描述" rules={[{ required: true, max: 10000 }]}><Input.TextArea rows={4} maxLength={10000} showCount /></Form.Item>
          <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select options={Object.entries(priorityLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="customerId" label="客户 ID" rules={[{ required: true, max: 256 }]}><Input maxLength={256} /></Form.Item>
          <Form.Item name="customerName" label="客户名称" rules={[{ required: true, max: 200 }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="customerEmail" label="客户邮箱" rules={[{ type: "email", max: 320 }]}><Input type="email" maxLength={320} /></Form.Item>
          <Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[","]} maxCount={20} aria-label="工单标签" /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
