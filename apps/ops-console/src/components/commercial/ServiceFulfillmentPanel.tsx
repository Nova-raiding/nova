import { useState } from "react";
import { Alert, Button, Card, Input, InputNumber, Select, Space, Typography } from "antd";
import type { CommercialOperationsController } from "../../hooks/useCommercialOperations.js";

export function ServiceFulfillmentPanel({ controller }: { controller: CommercialOperationsController }) {
  const [action, setAction] = useState<"create" | "schedule" | "start" | "complete" | "adjust">("start");
  const [allocation, setAllocation] = useState(""); const [revision, setRevision] = useState<number | null>(null); const [order, setOrder] = useState(""); const [entitlement, setEntitlement] = useState(""); const [serviceType, setServiceType] = useState(""); const [checksum, setChecksum] = useState(""); const [acceptanceRef, setAcceptanceRef] = useState(""); const [customerSubjectRef, setCustomerSubjectRef] = useState(""); const [acceptedAt, setAcceptedAt] = useState(""); const [unit, setUnit] = useState("count");
  const [quantity, setQuantity] = useState<number | null>(null); const [scheduleAt, setScheduleAt] = useState(""); const [eventId, setEventId] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [success, setSuccess] = useState(""); const [busy, setBusy] = useState(false);
  const enabled = controller.permissions.canWriteService && Boolean(controller.targetWorkspaceId);
  const submit = async () => {
    if (!enabled || reason.trim().length < 3 || busy) return;
    if (action === "create" && (!order.trim() || !entitlement.trim() || !serviceType.trim() || !checksum.trim() || !acceptanceRef.trim() || !customerSubjectRef.trim() || !acceptedAt.trim() || Number.isNaN(Date.parse(acceptedAt)) || quantity === null || quantity < 1)) return;
    if (action !== "create" && (!allocation.trim() || revision === null)) return;
    if ((action === "complete" || action === "adjust") && (quantity === null || quantity < 1)) return;
    if (action === "schedule" && !scheduleAt.trim()) return;
    if (action === "adjust" && !eventId.trim()) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      if (action === "create") await controller.client.createServiceAllocation({ workspace: controller.targetWorkspaceId, order: order.trim(), entitlement: entitlement.trim(), serviceType: serviceType.trim(), unit, quantity: quantity!, checksum: checksum.trim(), acceptanceRef: acceptanceRef.trim(), customerSubjectRef: customerSubjectRef.trim(), acceptedAt: new Date(acceptedAt).toISOString(), reason: reason.trim() });
      if (action === "schedule") await controller.client.scheduleService(controller.targetWorkspaceId, allocation.trim(), revision!, scheduleAt.trim(), reason.trim());
      if (action === "start") await controller.client.startService(controller.targetWorkspaceId, allocation.trim(), revision!, reason.trim());
      if (action === "complete") await controller.client.completeService(controller.targetWorkspaceId, allocation.trim(), revision!, quantity!, reason.trim());
      if (action === "adjust") await controller.client.adjustService(controller.targetWorkspaceId, allocation.trim(), revision!, eventId.trim(), quantity!, reason.trim());
      setSuccess("服务履约命令已被服务端接受；请刷新列表核验状态和证据。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "履约命令失败"); }
    finally { setBusy(false); }
  };
  return <Card size="small" title="服务履约操作" extra={<Typography.Text type="secondary">需要 revision、幂等键和审计原因</Typography.Text>}>
    {!controller.permissions.canWriteService && <Alert type="info" showIcon title="当前账号无履约写权限" description="当前页面保持只读。" />}
    {!controller.targetWorkspaceId && <Alert type="warning" showIcon title="缺少目标 Workspace" description="不能对未确定范围执行履约命令。" />}
    <Space wrap>
      <Select aria-label="履约动作" value={action} onChange={setAction} options={[{ value: "create", label: "创建分配" }, { value: "schedule", label: "排期" }, { value: "start", label: "开始" }, { value: "complete", label: "完成" }, { value: "adjust", label: "调整" }]} disabled={!enabled} />
      {action === "create" && <><Input placeholder="order_snapshot_id" value={order} onChange={event => setOrder(event.target.value)} disabled={!enabled} /><Input placeholder="entitlement_snapshot_id" value={entitlement} onChange={event => setEntitlement(event.target.value)} disabled={!enabled} /><Input placeholder="service_type" value={serviceType} onChange={event => setServiceType(event.target.value)} disabled={!enabled} /><Select value={unit} onChange={setUnit} options={[{ value: "count", label: "count" }, { value: "minute", label: "minute" }, { value: "contract_label", label: "contract_label" }]} /><Input placeholder="source_checksum" value={checksum} onChange={event => setChecksum(event.target.value)} disabled={!enabled} /><Input placeholder="客户边界确认凭证 acceptance_ref" value={acceptanceRef} onChange={event => setAcceptanceRef(event.target.value)} disabled={!enabled} /><Input placeholder="客户身份 customer_subject_ref" value={customerSubjectRef} onChange={event => setCustomerSubjectRef(event.target.value)} disabled={!enabled} /><Input aria-label="客户确认时间" placeholder="accepted_at，例如 2026-09-08T10:00:00.000Z" value={acceptedAt} onChange={event => setAcceptedAt(event.target.value)} disabled={!enabled} /></>}
      <Input aria-label="allocation id" placeholder="allocation_id" value={allocation} onChange={event => setAllocation(event.target.value)} disabled={!enabled} />
      <InputNumber aria-label="expected revision" min={1} placeholder="revision" value={revision ?? undefined} onChange={value => setRevision(typeof value === "number" ? value : null)} disabled={!enabled} />
      {(action === "create" || action === "complete" || action === "adjust") && <InputNumber aria-label="actual quantity" min={1} placeholder={action === "create" ? "分配数量" : "实际数量"} value={quantity ?? undefined} onChange={value => setQuantity(typeof value === "number" ? value : null)} disabled={!enabled} />}
      {action === "schedule" && <Input aria-label="schedule at" placeholder="schedule_at（ISO 时间）" value={scheduleAt} onChange={event => setScheduleAt(event.target.value)} disabled={!enabled} />}
      {action === "adjust" && <Input aria-label="corrects event id" placeholder="corrects_event_id" value={eventId} onChange={event => setEventId(event.target.value)} disabled={!enabled} />}
      <Input aria-label="fulfillment reason" placeholder="审计原因（至少 3 字符）" value={reason} onChange={event => setReason(event.target.value)} disabled={!enabled} />
      <Button type="primary" loading={busy} disabled={!enabled} onClick={() => void submit()}>提交命令</Button>
    </Space>
    {success && <Alert type="success" showIcon title={success} style={{ marginTop: 12 }} />}{error && <Alert type="error" showIcon title="履约命令未完成" description={error} style={{ marginTop: 12 }} />}
  </Card>;
}
