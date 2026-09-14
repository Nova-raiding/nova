import { Alert, Button } from "antd";
import { useEffect, useState } from "react";
import { OpsPage } from "../components/OpsPage.js";
import { CustomerDeliverySection } from "../components/delivery/CustomerDeliverySection.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import { customerDeliveryClient } from "../api/customerDeliveryClient.js";
import { describeOpsError } from "../api/opsClient.js";

export function CustomerDeliveryPage({ model }: { model: OpsConsoleModel }) {
  const canRead = model.authorization.can("customer.delivery.read");
  const targetWorkspaceId = model.authorizationTargetWorkspaceId?.trim() || model.opsWorkspaceId?.trim() || model.opsSession?.workspace_id?.trim() || "";
  const [records, setRecords] = useState<import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const load = async () => {
    if (!canRead || !targetWorkspaceId) return;
    setLoading(true); setError("");
    try { const result = await customerDeliveryClient.list(targetWorkspaceId); if (result === null) throw new Error("客户交付 API 未返回数据"); setRecords(result); }
    catch (cause) { setRecords([]); setError(describeOpsError(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canRead, targetWorkspaceId]);
  const saveChecklist = async (payload: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryChecklistSave) => {
    setMutationError("");
    try {
      if (!Number.isSafeInteger(payload.record.revision) || (payload.record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效 revision，请刷新后重试");
      const revision = payload.record.revision as number;
      await customerDeliveryClient.updateChecklist({
        targetWorkspaceId,
        deliveryId: payload.record.id,
        checklistKey: payload.checklistKey,
        items: payload.items,
        expectedRevision: revision,
      });
      // Reload the aggregate returned by the server so the progress and
      // activation state cannot drift from persisted checklist evidence.
      await load();
      const refreshed = (await customerDeliveryClient.list(targetWorkspaceId))?.find((record) => record.id === payload.record.id);
      return refreshed;
    } catch (cause) {
      const message = describeOpsError(cause);
      setMutationError(message);
      throw cause;
    }
  };
  const createRecord = async (companyName: string) => {
    try { const record = await customerDeliveryClient.create(targetWorkspaceId, companyName); await load(); return record; }
    catch (cause) { setMutationError(describeOpsError(cause)); throw cause; }
  };
  const saveProfile = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord) => {
    if (!Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效 revision，请刷新后重试");
    const revision = record.revision as number;
    const patch: Record<string, unknown> = {
      companyName: record.companyName,
      contractNumber: record.contractNo,
      paymentStatus: record.paymentStatus,
      contractRef: record.contractFile,
      projectOwner: record.owner,
      supportOwner: record.afterSalesOwner,
      paymentDate: record.paymentDate || undefined,
      plannedGoLiveAt: record.requiredLaunchAt,
      customerProfileStatus: "complete",
    };
    try { const updated = await customerDeliveryClient.update({ targetWorkspaceId, deliveryId: record.id, patch, expectedRevision: revision }); await load(); return updated; }
    catch (cause) { setMutationError(describeOpsError(cause)); throw cause; }
  };
  const loadChecklist = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, checklistKey: "system_integration" | "functional_acceptance") => customerDeliveryClient.listChecklistItems({ targetWorkspaceId, deliveryId: record.id, checklistKey });
  const saveTraining = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, completed: boolean) => {
    if (!Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效 revision，请刷新后重试");
    const revision = record.revision as number;
    try { const updated = await customerDeliveryClient.completeTraining({ targetWorkspaceId, deliveryId: record.id, completed, expectedRevision: revision }); await load(); return updated; }
    catch (cause) { setMutationError(describeOpsError(cause)); throw cause; }
  };
  const addVideo = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, input: { title: string; assetRef: string; sortOrder: number }) => {
    try { await customerDeliveryClient.addVideo({ targetWorkspaceId, deliveryId: record.id, ...input }); const refreshedList = await customerDeliveryClient.list(targetWorkspaceId); const refreshed = refreshedList?.find((candidate) => candidate.id === record.id); await load(); return refreshed; }
    catch (cause) { setMutationError(describeOpsError(cause)); throw cause; }
  };
  return (
    <OpsPage
      eyebrow="CUSTOMER DELIVERY"
      title="客户交付"
      description="以客户为中心跟进建档、系统接入、功能验收、培训和上线。付款未核验时，受控环节会保持阻断。"
      actions={<Button onClick={() => void load()} loading={loading} disabled={!canRead}>刷新交付档案</Button>}
    >
      {!canRead ? <Alert type="warning" showIcon message="当前会话没有客户交付读取权限" description="请切换到具备 customer.delivery.read 的平台运营工作区。" /> : null}
      {canRead && !targetWorkspaceId ? <Alert type="warning" showIcon message="请先选择目标企业工作区" description="客户交付是平台运营能力，必须在明确的 target_workspace_id 下读取或修改。" /> : null}
      {error ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付数据加载失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
      {mutationError ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付保存被阻断" description={mutationError} closable onClose={() => setMutationError("")} /> : null}
      <CustomerDeliverySection records={records} onCreate={createRecord} onSave={saveProfile} onChecklistSave={saveChecklist} onChecklistLoad={loadChecklist} onTrainingSave={saveTraining} onVideoAdd={addVideo} />
    </OpsPage>
  );
}
