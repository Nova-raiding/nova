import { Alert, Button, Card, Select, Space, Typography } from "antd";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { OpsPage } from "../components/OpsPage.js";
import { CustomerDeliverySection } from "../components/delivery/CustomerDeliverySection.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import type { WorkspaceSummary } from "../types/ops.js";
import { customerDeliveryClient } from "../api/customerDeliveryClient.js";
import { describeOpsError } from "../api/opsClient.js";
import { deliveryDateTimeIsoValue } from "../components/delivery/deliveryDateTime.js";

export function customerDeliveryWorkspaceOptions(workspaces: WorkspaceSummary[]) {
  return workspaces.map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.enterpriseName?.trim()
      ? `${workspace.enterpriseName} · ${workspace.workspaceId}`
      : workspace.workspaceId,
    disabled: workspace.status !== "active",
  }));
}

export function CustomerDeliveryPage({ model }: { model: OpsConsoleModel }) {
  const canRead = model.authorization.can("customer.delivery.read");
  const canUpdate = model.authorization.can("customer.delivery.update");
  const canBrowseWorkspaces = model.authorization.can("workspace.directory.read");
  // Platform delivery work must always use the explicitly selected enterprise
  // scope. Clearing the selector must not fall back to an ambient workspace.
  const targetWorkspaceId = canBrowseWorkspaces ? model.authorizationTargetWorkspaceId?.trim() || "" : "";
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const deferredWorkspaceQuery = useDeferredValue(workspaceQuery);
  const [records, setRecords] = useState<import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const currentWorkspace = useRef(targetWorkspaceId);
  currentWorkspace.current = targetWorkspaceId;
  const reportMutationError = (cause: unknown) => {
    if (currentWorkspace.current === targetWorkspaceId) setMutationError(describeOpsError(cause));
  };
  const loadRequest = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  const load = async () => {
    if (!canRead || !targetWorkspaceId || currentWorkspace.current !== targetWorkspaceId) return;
    loadRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = ++loadRequest.current.generation;
    loadRequest.current.controller = controller;
    const isCurrent = () => !controller.signal.aborted && currentWorkspace.current === targetWorkspaceId && loadRequest.current.generation === generation;
    setLoading(true); setError("");
    try {
      const result = await customerDeliveryClient.list(targetWorkspaceId, controller.signal);
      if (result === null) throw new Error("客户交付 API 未返回数据");
      if (isCurrent()) setRecords(result);
    }
    catch (cause) { if (isCurrent()) { setRecords([]); setError(describeOpsError(cause)); } }
    finally { if (isCurrent()) setLoading(false); }
  };
  useEffect(() => {
    if (!canRead || !canBrowseWorkspaces) return;
    void model.loadWorkspaceDirectory({
      query: deferredWorkspaceQuery.trim() || undefined,
      status: "active",
      merchantOnly: true,
      page: 1,
      pageSize: 100,
    });
  }, [canRead, canBrowseWorkspaces, deferredWorkspaceQuery]);
  useEffect(() => {
    setRecords([]);
    setError("");
    setMutationError("");
    void load();
    return () => { loadRequest.current.controller?.abort(); loadRequest.current.generation++; };
  }, [canRead, targetWorkspaceId]);
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
      if (currentWorkspace.current === targetWorkspaceId) setMutationError(message);
      throw cause;
    }
  };
  const createRecord = async (companyName: string) => {
    try { const record = await customerDeliveryClient.create(targetWorkspaceId, companyName); await load(); return record; }
    catch (cause) { reportMutationError(cause); throw cause; }
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
      plannedGoLiveAt: deliveryDateTimeIsoValue(record.requiredLaunchAt),
      customerProfileStatus: "complete",
    };
    try { const updated = await customerDeliveryClient.update({ targetWorkspaceId, deliveryId: record.id, patch, expectedRevision: revision }); await load(); return updated; }
    catch (cause) { reportMutationError(cause); throw cause; }
  };
  const loadChecklist = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, checklistKey: "system_integration" | "functional_acceptance") => customerDeliveryClient.listChecklistItems({ targetWorkspaceId, deliveryId: record.id, checklistKey });
  const saveTraining = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, completed: boolean) => {
    if (!Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效 revision，请刷新后重试");
    const revision = record.revision as number;
    try { const updated = await customerDeliveryClient.completeTraining({ targetWorkspaceId, deliveryId: record.id, completed, expectedRevision: revision }); await load(); return updated; }
    catch (cause) { reportMutationError(cause); throw cause; }
  };
  const addVideo = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, input: { title: string; assetRef: string; sortOrder: number }) => {
    try { await customerDeliveryClient.addVideo({ targetWorkspaceId, deliveryId: record.id, ...input }); }
    catch (cause) { reportMutationError(cause); throw cause; }
    // Registration has succeeded. A failed read must not make this segment
    // look unsaved and cause the operator to submit it for a second time.
    try {
      const refreshed = await customerDeliveryClient.get(targetWorkspaceId, record.id);
      if (currentWorkspace.current === targetWorkspaceId) setRecords((previous) => previous.map((candidate) => candidate.id === record.id ? refreshed : candidate));
      return refreshed;
    } catch (cause) {
      if (currentWorkspace.current === targetWorkspaceId) setError(`视频已登记，但最新档案读取失败。请刷新档案，不要重复登记。${describeOpsError(cause)}`);
      return undefined;
    }
  };
  const listVideos = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord) => {
    try {
      return await customerDeliveryClient.listVideos(targetWorkspaceId, record.id);
    } catch (cause) {
      reportMutationError(cause);
      throw cause;
    }
  };
  return (
    <OpsPage
      eyebrow="CUSTOMER DELIVERY"
      title="客户交付"
      description="以客户为中心跟进建档、系统接入、功能验收、培训和上线。付款未核验时，受控环节会保持阻断。"
      actions={<Button onClick={() => void load()} loading={loading} disabled={!canRead || !targetWorkspaceId}>刷新交付档案</Button>}
    >
      {!canRead ? <Alert type="warning" showIcon message="当前会话没有客户交付读取权限" description="请切换到具备 customer.delivery.read 的平台运营工作区。" /> : null}
      {canRead && !canUpdate ? <Alert style={{ marginBottom: 16 }} type="info" showIcon message="当前会话仅可查看客户交付" description="保存、上传和流程变更需要 customer.delivery.update 权限。" /> : null}
      {canRead && !canBrowseWorkspaces ? <Alert type="warning" showIcon message="当前会话不能读取企业工作区目录" description="请为平台运营账号补充 workspace.directory.read，才能选择客户并进入交付流程。" /> : null}
      {canRead && canBrowseWorkspaces ? (
        <Card size="small" title="目标企业工作区（必选）" style={{ marginBottom: 16 }}>
          <Space orientation="vertical" size="small" className="full-width">
            <Select
              showSearch
              allowClear
              aria-label="客户交付目标企业工作区"
              placeholder="搜索并选择企业名称或 Workspace ID"
              value={targetWorkspaceId || undefined}
              loading={model.workspaceDirectoryLoading}
              filterOption={false}
              onSearch={setWorkspaceQuery}
              onChange={(workspaceId) => model.setAuthorizationTargetWorkspaceId(workspaceId ?? "")}
              options={customerDeliveryWorkspaceOptions(model.workspaceRows)}
              notFoundContent={model.workspaceDirectoryLoading ? "正在加载企业工作区…" : "没有找到可用的企业工作区"}
              style={{ width: "min(100%, 560px)" }}
            />
            <Typography.Text type="secondary">
              交付档案只会在当前选中的企业工作区内读取和修改，切换后会重新加载。
            </Typography.Text>
          </Space>
        </Card>
      ) : null}
      {canRead && canBrowseWorkspaces && !targetWorkspaceId ? <Alert style={{ marginBottom: 16 }} type="info" showIcon message="请选择目标企业工作区后开始客户交付" description="平台管理员不会默认进入任何商家数据范围。" /> : null}
      {error ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付数据加载失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
      {mutationError ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付保存被阻断" description={mutationError} closable onClose={() => setMutationError("")} /> : null}
      <CustomerDeliverySection
        key={targetWorkspaceId || "unselected"}
        disabled={!canUpdate || !targetWorkspaceId}
        records={records}
        onCreate={createRecord}
        onSave={saveProfile}
        onChecklistSave={saveChecklist}
        onChecklistLoad={loadChecklist}
        onTrainingSave={saveTraining}
        onVideoAdd={addVideo}
        onVideoList={listVideos}
        onAssetUpload={(record, file, purpose, signal) => customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: record.id, file, purpose }, signal)}
        onAssetGet={(record, assetRef, purpose, signal) => customerDeliveryClient.getAsset({ targetWorkspaceId, deliveryId: record.id, assetRef, purpose }, signal)}
      />
    </OpsPage>
  );
}
