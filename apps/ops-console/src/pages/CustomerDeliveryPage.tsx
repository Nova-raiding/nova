import { Alert, Button, Card, Checkbox, DatePicker, Form, Input, Select, Space, message } from "antd";
import { CloseOutlined, UploadOutlined } from "@ant-design/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OpsPage } from "../components/OpsPage.js";
import { ACCEPTANCE_ITEMS, CustomerDeliverySection, INTEGRATION_ITEMS, checklistDisplayLabel } from "../components/delivery/CustomerDeliverySection.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import type { WorkspaceSummary } from "../types/ops.js";
import { customerDeliveryClient, type CustomerDeliveryAsset } from "../api/customerDeliveryClient.js";
import { describeOpsError } from "../api/opsClient.js";
import { accountLabel } from "../authz/accountLabel.js";
import { deliveryDateTimeIsoValue } from "../components/delivery/deliveryDateTime.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";
import { waitForDeliveryScan } from "../components/delivery/CustomerDeliveryUpload.js";

export function isCustomerDeliveryRevisionConflict(cause: unknown) {
  return /revision(?:[_ ]changed|[_ ]conflict)|版本.*(?:变化|冲突)/iu.test(describeOpsError(cause));
}

async function waitForCleanDeliveryAsset(initialAsset: CustomerDeliveryAsset, input: {
  targetWorkspaceId: string;
  deliveryId: string;
  signal: AbortSignal;
  purpose: "contract" | "video";
  label: string;
}) {
  let asset = initialAsset;
  for (let poll = 0; !asset.ready; poll++) {
    if (asset.scanStatus === "blocked") throw new Error(`${input.label}未通过安全检查，请更换文件后重试`);
    if (poll >= 15) throw new Error(`${input.label}安全检查暂未完成，已停止等待；请稍后再次点击创建，无需重新选择文件`);
    await waitForDeliveryScan(2000, input.signal);
    asset = await customerDeliveryClient.getAsset({ ...input, assetRef: asset.assetRef }, input.signal);
  }
  if (asset.scanStatus !== "clean") throw new Error(`${input.label}缺少可信安全检查结果，暂时无法创建客户`);
  return asset;
}

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
  const [uploadedContractFile, setUploadedContractFile] = useState<File>();
  const [deliveryVideoFiles, setDeliveryVideoFiles] = useState<File[]>([]);
  const [integrationChecks, setIntegrationChecks] = useState<string[]>([]);
  const [acceptanceChecks, setAcceptanceChecks] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const createErrorRef = useRef<HTMLDivElement>(null);
  const createSubmissionController = useRef<AbortController | undefined>(undefined);
  const pendingCreate = useRef<{
    companyName: string;
    record: CustomerDeliveryRecord;
    contract?: { file: File; assetRef: string };
    videos: Map<File, { assetRef: string; registered: boolean }>;
  } | undefined>(undefined);
  const [createForm] = Form.useForm<{
    companyName: string; contractNumber: string; paymentStatus: "paid" | "unpaid";
    paymentDate: { format: (pattern: string) => string }; contractFile: string; owner: string; afterSalesOwner: string; requiredLaunchAt: { format: (pattern: string) => string };
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
      createSubmissionController.current?.abort();
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
    let currentRecord = payload.record;
    try {
      const persist = (record: CustomerDeliveryRecord) => {
        if (!Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效版本，请刷新后重试");
        return customerDeliveryClient.updateChecklist({
          targetWorkspaceId: mutationWorkspaceId,
          deliveryId: record.id,
          checklistKey: payload.checklistKey,
          items: payload.items,
          expectedRevision: record.revision as number,
        });
      };
      let result;
      try { result = await persist(currentRecord); }
      catch (cause) {
        if (!isCustomerDeliveryRevisionConflict(cause)) throw cause;
        currentRecord = await customerDeliveryClient.get(mutationWorkspaceId, payload.record.id);
        result = await persist(currentRecord);
      }
      revision = result.revision;
    } catch (cause) {
      const message = describeOpsError(cause);
      if (currentWorkspace.current === targetWorkspaceId) setMutationError(message);
      throw cause;
    }

    // The checklist write is already durable. Only reconcile its aggregate
    // while the exact authorization generation that initiated it is current;
    // otherwise a late completion must not read the old tenant.
    const fallback = { ...currentRecord, revision };
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
  const submitCreatePage = async (values: { companyName: string; contractNumber: string; paymentStatus: "paid" | "unpaid"; paymentDate: { format: (pattern: string) => string }; contractFile: string; owner: string; afterSalesOwner: string; requiredLaunchAt: { format: (pattern: string) => string } }) => {
    if (createSubmissionController.current) return;
    if (integrationChecks.length < INTEGRATION_ITEMS.length || acceptanceChecks.length < ACCEPTANCE_ITEMS.length || deliveryVideoFiles.length === 0 || !uploadedContractFile) {
      message.error("请上传合同和交付视频，并完成系统接入、功能验收全部勾选");
      return;
    }
    const companyName = values.companyName.trim();
    const controller = new AbortController();
    createSubmissionController.current = controller;
    setCreating(true);
    setMutationError("");
    try {
      let attempt = pendingCreate.current;
      if (!attempt || attempt.companyName !== companyName) {
        // A previous attempt may already have created the draft before an
        // upload or scan failed. Resume that draft so a retry does not fail on
        // the unique company-name constraint.
        const existingDraft = records.find((record) => record.companyName.trim() === companyName && !record.profile);
        const record = existingDraft ?? await createRecord(companyName);
        attempt = { companyName, record, videos: new Map() };
        pendingCreate.current = attempt;
      }
      if (!attempt.contract || attempt.contract.file !== uploadedContractFile) {
        const uploaded = await customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: attempt.record.id, purpose: "contract", file: uploadedContractFile }, controller.signal);
        const asset = await waitForCleanDeliveryAsset(uploaded, { targetWorkspaceId, deliveryId: attempt.record.id, signal: controller.signal, purpose: "contract", label: "合同文件" });
        attempt.contract = { file: uploadedContractFile, assetRef: asset.assetRef };
      }
      for (const file of deliveryVideoFiles) {
        let video = attempt.videos.get(file);
        if (!video) {
          const uploaded = await customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: attempt.record.id, purpose: "video", file }, controller.signal);
          const asset = await waitForCleanDeliveryAsset(uploaded, { targetWorkspaceId, deliveryId: attempt.record.id, signal: controller.signal, purpose: "video", label: "交付视频" });
          video = { assetRef: asset.assetRef, registered: false };
          attempt.videos.set(file, video);
        }
      }
      attempt.record = await saveProfile({
        ...attempt.record,
        companyName,
        contractNo: values.contractNumber,
        paymentStatus: values.paymentStatus,
        paymentDate: values.paymentDate.format("YYYY-MM-DD"),
        contractFile: attempt.contract.assetRef,
        owner: values.owner,
        afterSalesOwner: values.afterSalesOwner,
        requiredLaunchAt: values.requiredLaunchAt.format("YYYY-MM-DD"),
        profile: true,
      });
      const integration = await customerDeliveryClient.updateChecklist({
        targetWorkspaceId, deliveryId: attempt.record.id, checklistKey: "system_integration",
        items: INTEGRATION_ITEMS.map(itemKey => ({ itemKey, completed: true, evidence: "", evidenceAssetRefs: [] })),
        expectedRevision: attempt.record.revision as number,
      }, controller.signal);
      attempt.record = { ...attempt.record, integration: true, revision: integration.revision ?? (attempt.record.revision as number) + 1 };
      const acceptance = await customerDeliveryClient.updateChecklist({
        targetWorkspaceId, deliveryId: attempt.record.id, checklistKey: "functional_acceptance",
        items: ACCEPTANCE_ITEMS.map(itemKey => ({ itemKey, completed: true, evidence: "", evidenceAssetRefs: [] })),
        expectedRevision: attempt.record.revision as number,
      }, controller.signal);
      attempt.record = { ...attempt.record, acceptance: true, revision: acceptance.revision ?? (attempt.record.revision as number) + 1 };
      for (const [index, file] of deliveryVideoFiles.entries()) {
        const video = attempt.videos.get(file)!;
        if (!video.registered) {
          await customerDeliveryClient.addVideo({ targetWorkspaceId, deliveryId: attempt.record.id, title: file.name, assetRef: video.assetRef, sortOrder: index }, controller.signal);
          video.registered = true;
        }
      }
      await load();
      pendingCreate.current = undefined;
      createForm.resetFields();
      setUploadedContractFile(undefined);
      setUploadedContractName("");
      setDeliveryVideoFiles([]);
      setCreatePage(false);
      message.success("客户创建成功");
    } catch (cause) {
      if (controller.signal.aborted) return;
      const rawMessage = describeOpsError(cause);
      const creationMessage = /company already exists/i.test(rawMessage)
        ? "该公司已存在，请返回客户建档查看，或修改公司名称后重试"
        : rawMessage;
      setMutationError(creationMessage);
      message.error(creationMessage);
      requestAnimationFrame(() => {
        createErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        createErrorRef.current?.focus({ preventScroll: true });
      });
    } finally {
      if (createSubmissionController.current === controller) createSubmissionController.current = undefined;
      if (mounted.current) setCreating(false);
    }
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
    const persist = (candidate: CustomerDeliveryRecord) => {
      if (!Number.isSafeInteger(candidate.revision) || (candidate.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效版本，请刷新后重试");
      return customerDeliveryClient.completeTraining({ targetWorkspaceId, deliveryId: candidate.id, completed, evidenceAssetRefs, expectedRevision: candidate.revision as number });
    };
    try {
      let updated;
      try { updated = await persist(record); }
      catch (cause) {
        if (!isCustomerDeliveryRevisionConflict(cause)) throw cause;
        const latest = await customerDeliveryClient.get(targetWorkspaceId, record.id);
        updated = await persist(latest);
      }
      await load();
      return updated;
    }
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
  const openDeliveryAsset = async (record: CustomerDeliveryRecord, assetRef: string, purpose: "contract" | "video", mode: "open" | "download") => {
    if (/^https:\/\//iu.test(assetRef)) {
      window.open(assetRef, "_blank", "noopener,noreferrer");
      return;
    }
    const preview = mode === "open" ? window.open("", "_blank") : null;
    try {
      const asset = await customerDeliveryClient.downloadAsset({ targetWorkspaceId, deliveryId: record.id, purpose, assetRef });
      const url = URL.createObjectURL(asset.blob);
      if (mode === "open") {
        if (preview) preview.location.href = url;
        else window.open(url, "_blank", "noopener,noreferrer");
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = asset.fileName;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      preview?.close();
      const messageText = describeOpsError(cause);
      setMutationError(messageText);
      message.error(messageText);
    }
  };
  const archiveRecord = async (record: CustomerDeliveryRecord) => {
    const persist = (candidate: CustomerDeliveryRecord) => {
      if (!Number.isSafeInteger(candidate.revision) || (candidate.revision ?? 0) < 1) throw new Error("客户交付记录缺少有效版本，请刷新后重试");
      return customerDeliveryClient.update({ targetWorkspaceId, deliveryId: candidate.id, patch: { archivedAt: new Date().toISOString() }, expectedRevision: candidate.revision as number });
    };
    try {
      try { await persist(record); }
      catch (cause) {
        if (!isCustomerDeliveryRevisionConflict(cause)) throw cause;
        await persist(await customerDeliveryClient.get(targetWorkspaceId, record.id));
      }
      setRecords((current) => current.filter((candidate) => candidate.id !== record.id));
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
      {mutationError && !createPage ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付保存被阻断" description={mutationError} closable onClose={() => setMutationError("")} /> : null}
      {createPage ? (<>
        <Form id="customer-create-form" className="customer-delivery-create-form" form={createForm} layout="vertical" onFinish={submitCreatePage}>
        <Card title="用户建档">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 16px" }}>
            <Form.Item name="companyName" label="公司名称" rules={[{ required: true, message: "请输入公司名称" }]}>
              <Input placeholder="请输入公司名称" autoFocus />
            </Form.Item>
            <Form.Item name="contractNumber" label="合同编号" rules={[{ required: true, message: "请输入合同编号" }]}><Input placeholder="例如：2026090801" /></Form.Item>
            <Form.Item name="paymentStatus" label="付款形式" rules={[{ required: true, message: "请选择付款形式" }]}><Select className="customer-delivery-payment-select" options={[{ value: "paid", label: "接入费" }, { value: "unpaid", label: "赠送" }]} /></Form.Item>
            <Form.Item name="paymentDate" label="付款时间" rules={[{ required: true, message: "请选择付款日期" }]}><DatePicker classNames={{ popup: { root: "customer-delivery-date-popup" } }} format="YYYY-MM-DD" placeholder="请选择付款日期" style={{ width: "100%" }} /></Form.Item>
            <Form.Item name="contractFile" label="合同文件或链接" rules={[{ required: true, message: "请上传合同或填写合同链接" }]}>
              <Input placeholder="" suffix={<Button type="text" className="customer-delivery-upload-button" aria-label="上传合同文件" title="上传合同文件" icon={<UploadOutlined />} onClick={() => contractFileInput.current?.click()} />} />
              <input ref={contractFileInput} hidden type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" onChange={(event) => { const file = event.target.files?.[0]; if (file) { createForm.setFieldValue("contractFile", file.name); setUploadedContractName(file.name); setUploadedContractFile(file); } }} />
              {uploadedContractName ? <div className="customer-delivery-uploaded-file">已选择：{uploadedContractName}<Button type="text" size="small" className="customer-delivery-clear-upload" aria-label="取消已选合同文件" title="取消已选文件" icon={<CloseOutlined />} onClick={() => { createForm.setFieldValue("contractFile", ""); setUploadedContractName(""); setUploadedContractFile(undefined); if (contractFileInput.current) contractFileInput.current.value = ""; }} /></div> : null}
            </Form.Item>
            </div>
        </Card>
        <div className="customer-delivery-check-card-row">
        <Card title={<span>系统接入确认 <em className="customer-delivery-required-mark">*</em></span>}>
          <div className="customer-delivery-check-grid customer-delivery-check-grid-five">
            {INTEGRATION_ITEMS.map((itemKey) => { const label = checklistDisplayLabel(itemKey); return (
              <label className="customer-delivery-check-item" key={itemKey}><span>{label === "创作点" || label === "商品资料" ? `${label}\u00a0` : label}</span><Checkbox checked={integrationChecks.includes(itemKey)} onChange={(event) => setIntegrationChecks((current) => event.target.checked ? [...current, itemKey] : current.filter((item) => item !== itemKey))} /></label>
            ); })}
          </div>
        </Card>
        <Card title={<span>功能测试及验收 <em className="customer-delivery-required-mark">*</em></span>}>
          <div className="customer-delivery-check-grid customer-delivery-check-grid-four">
            {ACCEPTANCE_ITEMS.map((itemKey) => <label className="customer-delivery-check-item" key={itemKey}><span>{checklistDisplayLabel(itemKey)}</span><Checkbox checked={acceptanceChecks.includes(itemKey)} onChange={(event) => setAcceptanceChecks((current) => event.target.checked ? [...current, itemKey] : current.filter((item) => item !== itemKey))} /></label>)}
          </div>
        </Card>
        </div>
        <Card title={<span>最终交付 <em className="customer-delivery-required-mark">*</em></span>} style={{ marginTop: 16 }}>
          <div className="customer-delivery-final-fields">
            <Form.Item name="owner" label="项目负责人" rules={[{ required: true, message: "请输入项目负责人" }]}><Input placeholder="例如：姜伟" /></Form.Item>
            <Form.Item name="afterSalesOwner" label="售后负责人" rules={[{ required: true, message: "请输入售后负责人" }]}><Input placeholder="例如：韩先晓" /></Form.Item>
            <Form.Item name="requiredLaunchAt" label="需求上线时间" rules={[{ required: true, message: "请选择上线日期" }]}><DatePicker classNames={{ popup: { root: "customer-delivery-date-popup" } }} format="YYYY-MM-DD" placeholder="请选择上线日期" style={{ width: "100%" }} /></Form.Item>
            <Form.Item label="交付视频" htmlFor="deliveryVideo" required className="customer-delivery-final-video">
              <div>
                <Input id="deliveryVideo" readOnly aria-label="交付视频（支持多段）" value={deliveryVideoFiles.map((file) => file.name).join("、")} placeholder="请选择交付视频" suffix={<Button type="text" className="customer-delivery-upload-button" aria-label="上传交付视频" title="上传交付视频" icon={<UploadOutlined />} onClick={() => deliveryVideoInput.current?.click()} />} />
                <input ref={deliveryVideoInput} hidden type="file" accept="video/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) setDeliveryVideoFiles((current) => [...current, ...files]); event.target.value = ""; }} />
                {deliveryVideoFiles.length ? <div className="customer-delivery-video-list">{deliveryVideoFiles.map((file, index) => <div className="customer-delivery-video-item" key={`${file.name}-${index}`}><span>{file.name}</span><Button type="text" size="small" icon={<CloseOutlined />} aria-label={`移除${file.name}`} onClick={() => setDeliveryVideoFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} /></div>)}</div> : null}
              </div>
            </Form.Item>
          </div>
        </Card>
        {mutationError ? <div ref={createErrorRef} className="customer-delivery-create-error" tabIndex={-1}><Alert type="error" showIcon message="创建客户失败" description={mutationError} /></div> : null}
        <div className="customer-delivery-create-actions">
          <Button disabled={creating} onClick={() => setCreatePage(false)}>返回客户建档</Button>
          <Space>
            <Button type="primary" htmlType="submit" form="customer-create-form" loading={creating}>{creating ? "正在创建" : "创建客户"}</Button>
          </Space>
        </div>
        </Form>
        </>
      ) : <CustomerDeliverySection
        key={targetWorkspaceId || "unselected"}
        disabled={!canRead || !targetWorkspaceId}
        records={records}
        onCreate={canUpdate && canRead ? createRecord : undefined}
        onCreateNavigate={canUpdate && canRead ? () => { setMutationError(""); pendingCreate.current = undefined; setCreatePage(true); } : undefined}
        onSave={canUpdate && canRead ? saveProfile : undefined}
        onChecklistSave={canUpdate && canRead ? saveChecklist : undefined}
        onChecklistLoad={loadChecklist}
        onTrainingSave={canUpdate && canRead ? saveTraining : undefined}
        onVideoAdd={canUpdate && canRead ? addVideo : undefined}
        onVideoList={listVideos}
        onAssetUpload={canUpdate && canRead ? (record, file, purpose, signal) => customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: record.id, file, purpose }, signal) : undefined}
        onAssetGet={(record, assetRef, purpose, signal) => customerDeliveryClient.getAsset({ targetWorkspaceId, deliveryId: record.id, assetRef, purpose }, signal)}
        onAssetOpen={openDeliveryAsset}
        onArchive={canUpdate && canRead ? archiveRecord : undefined}
        operatorActorId={model.opsSession?.actor_id}
        operatorName={accountLabel(model.opsSession)}
      />}
    </OpsPage>
  );
}
