import { useState } from "react";
import { Alert, Button, Card, Input, InputNumber, Modal, Space, Typography } from "antd";
import type { CommercialOperationsController } from "../../hooks/useCommercialOperations.js";

export function PointAdjustmentPanel({ controller }: { controller: CommercialOperationsController }) {
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canPropose = controller.permissions.canAdjustPoints && Boolean(controller.targetWorkspaceId);
  const submit = async () => {
    if (!canPropose || !delta || reason.trim().length < 3 || busy) return;
    setBusy(true); setError("");
    try {
      const result = await controller.client.proposePointAdjustment(controller.targetWorkspaceId, delta, reason.trim());
      const id = (result as { proposal_id?: string; proposalId?: string })?.proposal_id ?? (result as { proposalId?: string })?.proposalId;
      if (!id) throw new Error("服务端未返回 proposal_id，不能把调整视为已提交");
      setProposalId(id); setOpen(false); setDelta(null); setReason("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "点数调整提议失败"); }
    finally { setBusy(false); }
  };
  return <Card size="small" title="点数调整（双人审批）" extra={<Button type="primary" disabled={!canPropose} onClick={() => setOpen(true)}>新建调整提议</Button>}>
    {!controller.permissions.canAdjustPoints && <Alert type="info" showIcon title="当前账号无点数调整权限" description="页面不会发起调整请求。" />}
    {!controller.targetWorkspaceId && <Alert type="warning" showIcon title="缺少目标 Workspace" description="请先选择真实 workspace，不能对未知范围调整点数。" />}
    {proposalId && <Alert type="success" showIcon title="调整提议已创建，等待独立审批" description={<Typography.Text code>{proposalId}</Typography.Text>} />}
    {controller.permissions.canApprovePoints && <Space.Compact style={{ width: "100%" }}><Input aria-label="待审批 proposal id" value={proposalId} onChange={event => setProposalId(event.target.value)} placeholder="输入待审批 proposal_id" /><Button loading={busy} disabled={!proposalId.trim()} onClick={() => void (async () => { setBusy(true); setError(""); try { await controller.client.decidePointAdjustment(controller.targetWorkspaceId, proposalId.trim(), "approved", "运营台独立审批点数调整提议"); setProposalId(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "审批失败"); } finally { setBusy(false); } })()}>批准</Button><Button danger loading={busy} disabled={!proposalId.trim()} onClick={() => void (async () => { setBusy(true); setError(""); try { await controller.client.decidePointAdjustment(controller.targetWorkspaceId, proposalId.trim(), "rejected", "运营台驳回点数调整提议"); setProposalId(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "驳回失败"); } finally { setBusy(false); } })()}>驳回</Button></Space.Compact>}
    {error && <Alert type="error" showIcon title="调整提议失败" description={error} />}
    <Modal title="创建点数调整提议" open={open} okText="提交提议" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !delta || reason.trim().length < 3 }} onCancel={() => setOpen(false)} onOk={() => void submit()}>
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">目标 Workspace：{controller.targetWorkspaceId || "未选择"}</Typography.Text>
        <InputNumber aria-label="点数变更" value={delta ?? undefined} onChange={value => setDelta(typeof value === "number" ? value : null)} placeholder="正数增加，负数扣减" style={{ width: "100%" }} />
        <Input.TextArea aria-label="调整原因" value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={500} placeholder="至少 3 个字符的业务原因" showCount />
        <Alert type="warning" showIcon description="提交只创建不可变提议，不会立即改变余额；审批必须由另一具备审批 capability 的账号完成。" />
      </Space>
    </Modal>
  </Card>;
}
