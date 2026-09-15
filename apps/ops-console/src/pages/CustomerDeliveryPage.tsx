import { Alert, Button, Card, Checkbox, Form, Input, Select, Space, message } from "antd";
import { CloseOutlined, UploadOutlined } from "@ant-design/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OpsPage } from "../components/OpsPage.js";
import { CustomerDeliverySection } from "../components/delivery/CustomerDeliverySection.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import type { WorkspaceSummary } from "../types/ops.js";
import { customerDeliveryClient } from "../api/customerDeliveryClient.js";
import { describeOpsError } from "../api/opsClient.js";
import { deliveryDateTimeIsoValue } from "../components/delivery/deliveryDateTime.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";

export function buildCustomerDeliveryProfilePatch(record: CustomerDeliveryRecord) {
  return {
    companyName: record.companyName.trim(),
    contractNumber: record.contractNo?.trim() ?? "",
    paymentStatus: record.paymentStatus,
    contractRef: record.contractFile?.trim() ?? "",
    projectOwner: record.owner?.trim() ?? "",
    supportOwner: record.afterSalesOwner?.trim() ?? "",
    paymentDate: record.paymentDate || null,
    paymentEvidenceRefs: record.paymentEvidenceRefs ?? [],
    plannedGoLiveAt: deliveryDateTimeIsoValue(record.requiredLaunchAt) ?? null,
    customerProfileStatus: record.profile ? "complete" : "incomplete",
  };
}

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
  // Customer delivery is a shared operations workflow. Keep using the
  // platform's active workspace context for API compatibility, but do not
  // expose a tenant-switching control to sales/operations users.
  const targetWorkspaceId = model.authorizationTargetWorkspaceId?.trim() || model.workspaceRows[0]?.workspaceId || "";
  const [records, setRecords] = useState<import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [createPage, setCreatePage] = useState(false);
  const contractFileInput = useRef<HTMLInputElement>(null);
  const deliveryVideoInput = useRef<HTMLInputElement>(null);
  const [uploadedContractName, setUploadedContractName] = useState("");
  const [deliveryVideoFiles, setDeliveryVideoFiles] = useState<File[]>([]);
  const [integrationChecks, setIntegrationChecks] = useState<string[]>([]);
  const [acceptanceChecks, setAcceptanceChecks] = useState<string[]>([]);
  const [createForm] = Form.useForm<{
    companyName: string; contractNumber: string; paymentStatus: "paid" | "unpaid";
    paymentDate: string; contractFile: string; owner: string; afterSalesOwner: string; requiredLaunchAt: string;
  }>();
  const currentWorkspace = useRef(targetWorkspaceId);
  currentWorkspace.current = targetWorkspaceId;
  const currentCanRead = useRef(canRead);
  currentCanRead.current = canRead;
  const mounted = useRef(true);
  const reportMutationError = (cause: unknown) => {
    if (currentWorkspace.current === targetWorkspaceId) setMutationError(describeOpsError(cause));
  };
  const loadRequest = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadRequest.current.controller?.abort();
      loadRequest.current.generation++;
    };
  }, []);
  const hasCurrentReadAccess = (workspaceId: string, generation?: number) => Boolean(mounted.current && currentCanRead.current && workspaceId && currentWorkspace.current === workspaceId && (generation === undefined || loadRequest.current.generation === generation));
  const startCurrentRead = (workspaceId: string, expectedGeneration?: number) => {
    if (!hasCurrentReadAccess(workspaceId, expectedGeneration)) return undefined;
    loadRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = ++loadRequest.current.generation;
    loadRequest.current.controller = controller;
    return {
      controller,
      isCurrent: () => !controller.signal.aborted && hasCurrentReadAccess(workspaceId, generation),
    };
  };
  const load = async () => {
    // A completed mutation may call an older load closure. Its payload remains
    // unchanged, but any follow-up read must use today's permission/lifecycle.
    const request = startCurrentRead(targetWorkspaceId);
    if (!request) return;
    setLoading(true); setError("");
    try {
      const result = await customerDeliveryClient.list(targetWorkspaceId, request.controller.signal);
      if (result === null) throw new Error("客户交付 API 未返回数据");
      if (request.isCurrent()) setRecords(result);
    }
    catch (cause) { if (request.isCurrent()) { setRecords([]); setError(describeOpsError(cause)); } }
    finally { if (request.isCurrent()) setLoading(false); }
  };
  useEffect(() => {
    if (!canRead) return;
    void model.loadWorkspaceDirectory({
      status: "active",
      merchantOnly: true,
      page: 1,
      pageSize: 100,
    });
  }, [canRead]);
  useEffect(() => {
    setRecords([]);
    setError("");
    setMutationError("");
    void load();
    return () => { loadRequest.current.controller?.abort(); loadRequest.current.generation++; };
  }, [canRead, targetWorkspaceId]);
  const saveChecklist = async (payload: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryChecklistSave) => {
    setMutationError("");
    const mutationWorkspaceId = targetWorkspaceId;
    const mutationGeneration = loadRequest.current.generation;
    let revision: number | undefined;
    try {
      if (!Number.isSafeInteger(payload.record.revision) || (payload.record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效 revision，请刷新后重试");
      const result = await customerDeliveryClient.updateChecklist({
        targetWorkspaceId: mutationWorkspaceId,
        deliveryId: payload.record.id,
        checklistKey: payload.checklistKey,
        items: payload.items,
        expectedRevision: payload.record.revision as number,
      });
      revision = result.revision;
    } catch (cause) {
      const message = describeOpsError(cause);
      if (currentWorkspace.current === targetWorkspaceId) setMutationError(message);
      throw cause;
    }

    // The checklist write is already durable. Only reconcile its aggregate
    // while the exact authorization generation that initiated it is current;
    // otherwise a late completion must not read the old tenant.
    const fallback = { ...payload.record, revision };
    if (!hasCurrentReadAccess(mutationWorkspaceId, mutationGeneration)) return fallback;
    const request = startCurrentRead(mutationWorkspaceId, mutationGeneration);
    if (!request) return fallback;
    try {
      const refreshed = await customerDeliveryClient.get(mutationWorkspaceId, payload.record.id, request.controller.signal);
      if (request.isCurrent()) setRecords((previous) => previous.map((record) => record.id === payload.record.id ? refreshed : record));
      return request.isCurrent() ? refreshed : fallback;
    } catch (cause) {
      if (request.isCurrent()) {
        setRecords((previous) => previous.map((record) => record.id === payload.record.id ? fallback : record));
        setError(`清单已保存，但最新档案读取失败。请刷新档案，不要重复保存。${describeOpsError(cause)}`);
      }
      return fallback;
    }
  };
  const createRecord = async (companyName: string) => {
    try { const record = await customerDeliveryClient.create(targetWorkspaceId, companyName); await load(); return record; }
    catch (cause) { reportMutationError(cause); throw cause; }
  };
  const submitCreatePage = async (values: { companyName: string; contractNumber: string; paymentStatus: "paid" | "unpaid"; paymentDate: string; contractFile: string; owner: string; afterSalesOwner: string; requiredLaunchAt: string }) => {
    if (integrationChecks.length < 10 || acceptanceChecks.length < 8 || deliveryVideoFiles.length === 0) {
      message.error("请完成系统接入、功能验收全部勾选，并上传至少一段交付视频");
      return;
    }
    const created = await createRecord(values.companyName);
    for (const [index, file] of deliveryVideoFiles.entries()) {
      const asset = await customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: created.id, purpose: "video", file });
      await customerDeliveryClient.addVideo({ targetWorkspaceId, deliveryId: created.id, title: file.name, assetRef: asset.assetRef, sortOrder: index });
    }
    await saveProfile({
      ...created,
      companyName: values.companyName,
      contractNo: values.contractNumber,
      paymentStatus: values.paymentStatus,
      paymentDate: values.paymentDate,
      contractFile: values.contractFile,
      owner: values.owner,
      afterSalesOwner: values.afterSalesOwner,
      requiredLaunchAt: values.requiredLaunchAt,
      profile: true,
    });
    createForm.resetFields();
    setDeliveryVideoFiles([]);
    setCreatePage(false);
  };
  const saveProfile = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord) => {
    if (!Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效 revision，请刷新后重试");
    const revision = record.revision as number;
    const patch = buildCustomerDeliveryProfilePatch(record);
    try { const updated = await customerDeliveryClient.update({ targetWorkspaceId, deliveryId: record.id, patch, expectedRevision: revision }); await load(); return updated; }
    catch (cause) { reportMutationError(cause); throw cause; }
  };
  const loadChecklist = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, checklistKey: "system_integration" | "functional_acceptance") => {
    const request = startCurrentRead(targetWorkspaceId);
    if (!request) return [];
    try {
      const items = await customerDeliveryClient.listChecklistItems({ targetWorkspaceId, deliveryId: record.id, checklistKey }, request.controller.signal);
      return request.isCurrent() ? items : [];
    } catch (cause) {
      if (!request.isCurrent()) return [];
      reportMutationError(cause);
      throw cause;
    }
  };
  const saveTraining = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, completed: boolean, evidenceAssetRefs: string[]) => {
    if (!Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效 revision，请刷新后重试");
    const revision = record.revision as number;
    try { const updated = await customerDeliveryClient.completeTraining({ targetWorkspaceId, deliveryId: record.id, completed, evidenceAssetRefs, expectedRevision: revision }); await load(); return updated; }
    catch (cause) { reportMutationError(cause); throw cause; }
  };
  const addVideo = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord, input: { title: string; assetRef: string; sortOrder: number }) => {
    const mutationWorkspaceId = targetWorkspaceId;
    const mutationGeneration = loadRequest.current.generation;
    try { await customerDeliveryClient.addVideo({ targetWorkspaceId, deliveryId: record.id, ...input }); }
    catch (cause) { reportMutationError(cause); throw cause; }
    // Registration has succeeded. A failed read must not make this segment
    // look unsaved and cause the operator to submit it for a second time.
    // Reconcile only while the initiating read scope is still current; this
    // also rejects A -> B -> A and unmounts without undoing the acknowledged write.
    const request = startCurrentRead(mutationWorkspaceId, mutationGeneration);
    if (!request) return undefined;
    try {
      const refreshed = await customerDeliveryClient.get(mutationWorkspaceId, record.id, request.controller.signal);
      if (request.isCurrent()) setRecords((previous) => previous.map((candidate) => candidate.id === record.id ? refreshed : candidate));
      return request.isCurrent() ? refreshed : undefined;
    } catch (cause) {
      if (request.isCurrent()) setError(`视频已登记，但最新档案读取失败。请刷新档案，不要重复登记。${describeOpsError(cause)}`);
      return undefined;
    }
  };
  const listVideos = async (record: import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord) => {
    const request = startCurrentRead(targetWorkspaceId);
    if (!request) return [];
    try {
      const videos = await customerDeliveryClient.listVideos(targetWorkspaceId, record.id, request.controller.signal);
      return request.isCurrent() ? videos : [];
    } catch (cause) {
      reportMutationError(cause);
      throw cause;
    }
  };
  return (
    <OpsPage
      eyebrow="CUSTOMER DELIVERY"
      title="客户交付"
      hideTitle
      description="以客户为中心跟进建档、系统接入、功能验收、培训和上线。付款未核验时，受控环节会保持阻断。"
      actions={<Button onClick={() => void load()} loading={loading} disabled={!canRead || !targetWorkspaceId}>刷新交付档案</Button>}
    >
      {!canRead ? <Alert type="warning" showIcon message="当前会话没有客户交付读取权限" description="请切换到具备 customer.delivery.read 的平台运营工作区。" /> : null}
      {canRead && !canUpdate ? <Alert style={{ marginBottom: 16 }} type="info" showIcon message="当前会话仅可查看客户交付" description="保存、上传和流程变更需要 customer.delivery.update 权限。" /> : null}
      {!targetWorkspaceId && canRead ? <Alert style={{ marginBottom: 16 }} type="info" showIcon message="正在加载客户交付档案" description="请稍候，运营数据加载完成后即可新建客户。" /> : null}
      {error ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付数据加载失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
      {mutationError ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付保存被阻断" description={mutationError} closable onClose={() => setMutationError("")} /> : null}
      {createPage ? (<>
        <Form id="customer-create-form" className="customer-delivery-create-form" form={createForm} layout="vertical" onFinish={submitCreatePage}>
        <Card title="用户建档">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 16px" }}>
            <Form.Item name="companyName" label="公司名称" rules={[{ required: true, message: "请输入公司名称" }]}>
              <Input placeholder="请输入公司名称" autoFocus />
            </Form.Item>
            <Form.Item name="contractNumber" label="合同编号" rules={[{ required: true, message: "请输入合同编号" }]}><Input placeholder="例如：2026090801" /></Form.Item>
            <Form.Item name="paymentStatus" label="付款形式" rules={[{ required: true, message: "请选择付款形式" }]}><Select className="customer-delivery-payment-select" options={[{ value: "paid", label: "接入费" }, { value: "unpaid", label: "赠送" }]} /></Form.Item>
            <Form.Item name="paymentDate" label="付款时间" rules={[{ required: true, message: "请选择付款日期" }]}><Input type="date" onClick={(event) => event.currentTarget.showPicker?.()} /></Form.Item>
            <Form.Item name="contractFile" label="合同文件或链接" rules={[{ required: true, message: "请上传合同或填写合同链接" }]}>
              <Input placeholder="" suffix={<Button type="text" className="customer-delivery-upload-button" aria-label="上传合同文件" title="上传合同文件" icon={<UploadOutlined />} onClick={() => contractFileInput.current?.click()} />} />
              <input ref={contractFileInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) { createForm.setFieldValue("contractFile", file.name); setUploadedContractName(file.name); } }} />
              {uploadedContractName ? <div className="customer-delivery-uploaded-file">已选择：{uploadedContractName}<Button type="text" size="small" className="customer-delivery-clear-upload" aria-label="取消已选合同文件" title="取消已选文件" icon={<CloseOutlined />} onClick={() => { createForm.setFieldValue("contractFile", ""); setUploadedContractName(""); if (contractFileInput.current) contractFileInput.current.value = ""; }} /></div> : null}
            </Form.Item>
            </div>
        </Card>
        <div className="customer-delivery-check-card-row">
        <Card title={<span>系统接入确认 <em className="customer-delivery-required-mark">*</em></span>}>
          <div className="customer-delivery-check-grid customer-delivery-check-grid-five">
            {["插件账户", "店铺连接", "商品扫描", "知识库功能", "平台规则", "创作点", "企业信息", "品牌资产", "商品资料", "客户偏好"].map((label) => (
              <label className="customer-delivery-check-item" key={label}><span>{label === "创作点" || label === "商品资料" ? `${label}\u00a0` : label}</span><Checkbox checked={integrationChecks.includes(label)} onChange={(event) => setIntegrationChecks((current) => event.target.checked ? [...current, label] : current.filter((item) => item !== label))} /></label>
            ))}
          </div>
        </Card>
        <Card title={<span>功能测试及验收 <em className="customer-delivery-required-mark">*</em></span>}>
          <div className="customer-delivery-check-grid customer-delivery-check-grid-four">
            {["文案生成", "图片生成", "批注修改", "自动检查", "视频生成", "资料读取", "技术验收", "内容验收"].map((label) => (
              <label className="customer-delivery-check-item" key={label}><span>{label}</span><Checkbox checked={acceptanceChecks.includes(label)} onChange={(event) => setAcceptanceChecks((current) => event.target.checked ? [...current, label] : current.filter((item) => item !== label))} /></label>
            ))}
          </div>
        </Card>
        </div>
        <Card title={<span>最终交付 <em className="customer-delivery-required-mark">*</em></span>} style={{ marginTop: 16 }}>
          <div className="customer-delivery-final-fields">
            <Form.Item name="owner" label="项目负责人" rules={[{ required: true, message: "请输入项目负责人" }]}><Input placeholder="例如：姜伟" /></Form.Item>
            <Form.Item name="afterSalesOwner" label="售后负责人" rules={[{ required: true, message: "请输入售后负责人" }]}><Input placeholder="例如：韩先晓" /></Form.Item>
            <Form.Item name="requiredLaunchAt" label="需求上线时间" rules={[{ required: true, message: "请选择上线日期" }]}><Input type="date" onClick={(event) => event.currentTarget.showPicker?.()} /></Form.Item>
            <div className="customer-delivery-final-video"><input ref={deliveryVideoInput} hidden type="file" accept="video/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) setDeliveryVideoFiles((current) => [...current, ...files]); event.target.value = ""; }} /><Button size="small" icon={<UploadOutlined />} onClick={() => deliveryVideoInput.current?.click()}>上传交付视频</Button>{deliveryVideoFiles.length ? <div className="customer-delivery-video-list">{deliveryVideoFiles.map((file, index) => <div className="customer-delivery-video-item" key={`${file.name}-${index}`}><span>{file.name}</span><Button type="text" size="small" icon={<CloseOutlined />} aria-label={`移除${file.name}`} onClick={() => setDeliveryVideoFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} /></div>)}</div> : null}</div>
          </div>
        </Card>
        <div className="customer-delivery-create-actions">
          <Button onClick={() => setCreatePage(false)}>返回客户建档</Button>
          <Space>
            <Button type="primary" htmlType="submit" form="customer-create-form">创建客户</Button>
          </Space>
        </div>
        </Form>
        </>
      ) : <CustomerDeliverySection
        key={targetWorkspaceId || "unselected"}
        disabled={!canRead || !targetWorkspaceId}
        records={records}
        onCreate={canUpdate && canRead ? createRecord : undefined}
        onCreateNavigate={canUpdate && canRead ? () => setCreatePage(true) : undefined}
        onSave={canUpdate && canRead ? saveProfile : undefined}
        onChecklistSave={canUpdate && canRead ? saveChecklist : undefined}
        onChecklistLoad={loadChecklist}
        onTrainingSave={canUpdate && canRead ? saveTraining : undefined}
        onVideoAdd={canUpdate && canRead ? addVideo : undefined}
        onVideoList={listVideos}
        onAssetUpload={canUpdate && canRead ? (record, file, purpose, signal) => customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: record.id, file, purpose }, signal) : undefined}
        onAssetGet={(record, assetRef, purpose, signal) => customerDeliveryClient.getAsset({ targetWorkspaceId, deliveryId: record.id, assetRef, purpose }, signal)}
      />}
    </OpsPage>
  );
}
