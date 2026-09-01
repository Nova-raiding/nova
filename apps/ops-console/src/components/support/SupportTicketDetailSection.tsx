import { Alert, Button, Card, Empty, Form, Input, Modal, Select, Space, Spin, Tag, Timeline, Typography } from "antd";
import { useState } from "react";
import type { SupportTicketEventContract, SupportTicketStatus } from "../../../../../packages/contracts/src/ops/support.js";
import type { SupportDomainModel } from "../../hooks/useSupportDomain.js";

const transitionOptions: Array<{ value: SupportTicketStatus; label: string }> = [
  { value: "open", label: "待处理" }, { value: "in_progress", label: "处理中" },
  { value: "waiting_customer", label: "等待客户" }, { value: "resolved", label: "已解决" }, { value: "closed", label: "已关闭" },
];
const eventLabels: Record<SupportTicketEventContract["eventType"], string> = {
  created: "创建工单", assigned: "分配负责人", status_changed: "变更状态", commented: "添加备注", sla_at_risk: "SLA 临期提醒", sla_breached: "SLA 违约提醒",
};
const slaStateLabels = { on_track: "SLA 正常", at_risk: "SLA 临近", breached: "SLA 已超时", met: "SLA 已达成" } as const;
const slaStateColors = { on_track: "green", at_risk: "orange", breached: "red", met: "blue" } as const;

export function SupportTicketDetailSection({ model }: { model: SupportDomainModel }) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [status, setStatus] = useState<SupportTicketStatus>("in_progress");
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [visibility, setVisibility] = useState<"internal" | "customer">("internal");

  if (model.detailLoading) return <Card title="工单详情"><Spin description="正在加载工单详情"><div style={{ minHeight: 160 }} /></Spin></Card>;
  if (!model.selected) return <Card title="工单详情"><Empty description="从工单队列中选择一项查看完整事件历史" /></Card>;
  const { ticket, events } = model.selected;
  const sla = ticket.sla;

  return (
    <Card
      title={`${ticket.ticketNumber} · ${ticket.subject}`}
      extra={<Button onClick={model.clearSelection}>关闭详情</Button>}
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Tag>{ticket.status}</Tag><Tag color={ticket.priority === "urgent" ? "red" : "blue"}>{ticket.priority}</Tag>
        {sla ? <Tag color={slaStateColors[sla.state]}>{slaStateLabels[sla.state]}</Tag> : <Tag>旧工单待回填 SLA</Tag>}
        <Typography.Text>版本 {ticket.revision}</Typography.Text>
        <Typography.Text>负责人：{ticket.assignedTo ?? "未分配"}</Typography.Text>
      </Space>
      {sla ? <Alert
        type={sla.state === "breached" ? "error" : sla.state === "at_risk" ? "warning" : "info"}
        showIcon
        role="status"
        title="SLA 履约时钟"
        description={`首响截止：${new Date(sla.firstResponseDueAt).toLocaleString()}；解决截止：${new Date(sla.resolutionDueAt).toLocaleString()}；已暂停 ${sla.pausedMinutes ?? 0} 分钟${sla.pauseStartedAt ? "（当前暂停）" : ""}；${sla.firstResponseAt ? `首响于 ${new Date(sla.firstResponseAt).toLocaleString()}` : "尚未记录首响"}；策略版本 ${sla.policy.version}`}
        style={{ marginBottom: 16 }}
      /> : <Alert type="warning" showIcon role="status" title="SLA 履约时钟待回填" description="该历史工单尚未携带 SLA 快照；系统不会推测截止时间，请由运营完成回填后再判断是否超时。" style={{ marginBottom: 16 }} />}
      <Typography.Paragraph>{ticket.description}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 24 }}>
        <Button disabled={model.mutating} onClick={() => setAssignOpen(true)}>分配负责人</Button>
        <Button disabled={model.mutating} onClick={() => setTransitionOpen(true)}>变更状态</Button>
        <Button type="primary" disabled={model.mutating} onClick={() => setCommentOpen(true)}>添加备注</Button>
      </Space>
      <Typography.Title level={5}>不可变事件历史</Typography.Title>
      {events.length === 0 ? <Alert type="warning" showIcon title="事件历史为空" description="工单投影存在但事件缺失，请停止修改并检查事件存储。" /> : (
        <Timeline items={events.map(event => ({
          content: <Space orientation="vertical" size={0}>
            <Typography.Text strong>{eventLabels[event.eventType]} · #{event.sequence}</Typography.Text>
            <Typography.Text type="secondary">{event.actorId} · {new Date(event.createdAt).toLocaleString()}</Typography.Text>
            <Typography.Text className="ops-token">{JSON.stringify(event.payload)}</Typography.Text>
          </Space>,
        }))} />
      )}

      <Modal title="分配工单" open={assignOpen} confirmLoading={model.mutating} okButtonProps={{ disabled: !assignee.trim() }} onCancel={() => setAssignOpen(false)} onOk={() => void model.assign(assignee).then(() => { setAssignee(""); setAssignOpen(false); }).catch(() => undefined)}>
        <label htmlFor="support-assignee">负责人 ID</label>
        <Input id="support-assignee" value={assignee} maxLength={256} onChange={event => setAssignee(event.target.value)} autoFocus />
      </Modal>
      <Modal title="变更工单状态" open={transitionOpen} confirmLoading={model.mutating} okButtonProps={{ disabled: reason.trim().length < 3 }} onCancel={() => setTransitionOpen(false)} onOk={() => void model.transition(status, reason).then(() => { setReason(""); setTransitionOpen(false); }).catch(() => undefined)}>
        <Form layout="vertical">
          <Form.Item label="目标状态" required><Select value={status} options={transitionOptions} onChange={setStatus} /></Form.Item>
          <Form.Item label="变更原因" required><Input.TextArea value={reason} rows={3} maxLength={1000} showCount onChange={event => setReason(event.target.value)} /></Form.Item>
        </Form>
      </Modal>
      <Modal title="添加工单备注" open={commentOpen} confirmLoading={model.mutating} okButtonProps={{ disabled: !comment.trim() }} onCancel={() => setCommentOpen(false)} onOk={() => void model.comment(comment, visibility).then(() => { setComment(""); setCommentOpen(false); }).catch(() => undefined)}>
        <Form layout="vertical">
          <Form.Item label="可见范围" required><Select value={visibility} onChange={setVisibility} options={[{ value: "internal", label: "仅内部" }, { value: "customer", label: "客户可见" }]} /></Form.Item>
          <Form.Item label="备注内容" required><Input.TextArea value={comment} rows={5} maxLength={10000} showCount onChange={event => setComment(event.target.value)} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
