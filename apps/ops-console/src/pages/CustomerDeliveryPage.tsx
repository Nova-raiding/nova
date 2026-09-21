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
import { useUnsavedChanges } from "../components/authz/UnsavedChangesContext.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";
import { waitForDeliveryScan } from "../components/delivery/CustomerDeliveryUpload.js";

export function isCustomerDeliveryRevisionConflict(cause: unknown) {
  return /revision(?:[_ ]changed|[_ ]conflict)|版本.*(?:变化|冲突)/iu.test(describeOpsError(cause));
}
async function waitForCleanDeliveryAsset(initialAsset: CustomerDeliveryAsset, input: {
  targetWorkspaceId: string;
  deliveryId: string;
  signal: AbortSignal;
  purpose: "contract";
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

/**
 * The batch checklist endpoint answers with the saved item list, so the client
 * only reports a `revision` when the response happens to carry one. Merging
 * that absent value into the record would erase a revision the record already
 * had, and the next write on the same row would then be refused as "missing a
 * version" - a failure the operator cannot fix without a full reload.
 */
export function withChecklistRevision(
  record: CustomerDeliveryRecord,
  revision: number | undefined,
): CustomerDeliveryRecord {
  return revision === undefined ? record : { ...record, revision };
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
  // Every read and write is bound to an explicit operator-selected workspace.
  // Never fall back to `workspaceRows[0]`: directory order is not consent to
  // target a tenant. Customer delivery owns this selector because the former
  // commercial-overview selector is no longer mounted in the converged console.
  const targetWorkspaceId = model.authorizationTargetWorkspaceId?.trim() ?? "";
  const [records, setRecords] = useState<import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [createPage, setCreatePage] = useState(false);
  const contractFileInput = useRef<HTMLInputElement>(null);
  const [uploadedContractName, setUploadedContractName] = useState("");
  const [uploadedContractFile, setUploadedContractFile] = useState<File>();
  const [integrationChecks, setIntegrationChecks] = useState<string[]>([]);
  const [acceptanceChecks, setAcceptanceChecks] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createDraftDirty, setCreateDraftDirty] = useState(false);
  // The workbench switch confirmation only fires for a form that registered
  // itself as dirty. Without a live registrant the guard could never arm and a
  // half-filled customer profile was discarded without any prompt, so the one
  // reachable draft form on this page registers itself here.
  useUnsavedChanges(createPage && createDraftDirty, "客户建档表单");
  const createErrorRef = useRef<HTMLDivElement>(null);
  const createSubmissionController = useRef<AbortController | undefined>(undefined);
  const pendingCreate = useRef<{
    companyName: string;
    record: CustomerDeliveryRecord;
    contract?: { file: File; assetRef: string };
  } | undefined>(undefined);
  const [createForm] = Form.useForm<{
    companyName: string; contractNumber: string; paymentStatus: "paid" | "unpaid";
    paymentDate: { format: (pattern: string) => string }; contractFile: string; owner: string; afterSalesOwner: string;
  }>();
  const currentWorkspace = useRef(targetWorkspaceId);
  currentWorkspace.current = targetWorkspaceId;
  const currentCanRead = useRef(canRead);
  currentCanRead.current = canRead;
  const currentCanUpdate = useRef(canUpdate);
  currentCanUpdate.current = canUpdate;
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
    const fallback = withChecklistRevision(currentRecord, revision);
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
  const submitCreatePage = async (values: { companyName: string; contractNumber: string; paymentStatus: "paid" | "unpaid"; paymentDate: { format: (pattern: string) => string }; contractFile: string; owner: string; afterSalesOwner: string }) => {
    if (createSubmissionController.current) return;
    if (integrationChecks.length < INTEGRATION_ITEMS.length || acceptanceChecks.length < ACCEPTANCE_ITEMS.length || !uploadedContractFile) {
      message.error("请上传合同，并完成系统接入、功能验收全部勾选");
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
        attempt = { companyName, record };
        pendingCreate.current = attempt;
      }
      if (!attempt.contract || attempt.contract.file !== uploadedContractFile) {
        const uploaded = await customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: attempt.record.id, purpose: "contract", file: uploadedContractFile }, controller.signal);
        const asset = await waitForCleanDeliveryAsset(uploaded, { targetWorkspaceId, deliveryId: attempt.record.id, signal: controller.signal, purpose: "contract", label: "合同文件" });
        attempt.contract = { file: uploadedContractFile, assetRef: asset.assetRef };
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
      await load();
      pendingCreate.current = undefined;
      createForm.resetFields();
      setUploadedContractFile(undefined);
      setUploadedContractName("");
      setCreateDraftDirty(false);
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
  const openDeliveryAsset = async (record: CustomerDeliveryRecord, assetRef: string, purpose: "contract", mode: "open" | "download") => {
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
      actions={<Space wrap>
        <Select
          aria-label="客户交付目标企业工作区"
          placeholder="选择目标企业"
          value={targetWorkspaceId || undefined}
          options={customerDeliveryWorkspaceOptions(model.workspaceRows)}
          loading={model.workspaceDirectoryLoading}
          disabled={!canRead || createDraftDirty}
          onChange={(workspaceId) => model.setAuthorizationTargetWorkspaceId(workspaceId)}
          style={{ minWidth: 280 }}
        />
        <Button onClick={() => void load()} loading={loading} disabled={!canRead || !targetWorkspaceId}>刷新交付档案</Button>
      </Space>}
    >
      {!canRead ? <Alert type="warning" showIcon title="当前会话没有客户交付读取权限" description="请切换到具备 customer.delivery.read 的平台运营工作区。" /> : null}
      {canRead && !canUpdate ? <Alert style={{ marginBottom: 16 }} type="info" showIcon title="当前会话仅可查看客户交付" description="保存、上传和流程变更需要 customer.delivery.update 权限。" /> : null}
      {!targetWorkspaceId && canRead ? <Alert style={{ marginBottom: 16 }} type="warning" showIcon title="尚未选择客户工作区" description="客户交付只能读取和写入操作员显式选择的工作区。请先在平台总览的「商家经营台账」中点击“查看该企业授权”，再返回本页；档案读取与建档、上传、验收写动作会随该选择启用。" /> : null}
      {error ? <Alert style={{ marginBottom: 16 }} type="error" showIcon title="客户交付数据加载失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
      {mutationError && !createPage ? <Alert style={{ marginBottom: 16 }} type="error" showIcon title="客户交付保存被阻断" description={mutationError} closable onClose={() => setMutationError("")} /> : null}
      {createPage ? (<>
        <Form id="customer-create-form" className="customer-delivery-create-form" form={createForm} layout="vertical" onFinish={submitCreatePage} onValuesChange={() => setCreateDraftDirty(true)}>
        <Card title="用户建档">
            <div className="customer-delivery-profile-fields">
            <Form.Item name="companyName" label="公司名称" rules={[{ required: true, message: "请输入公司名称" }]}>
              <Input placeholder="请输入公司名称" autoFocus />
            </Form.Item>
            <Form.Item name="contractNumber" label="合同编号" rules={[{ required: true, message: "请输入合同编号" }]}><Input placeholder="例如：2026090801" /></Form.Item>
            <Form.Item name="paymentStatus" label="付款形式" rules={[{ required: true, message: "请选择付款形式" }]}><Select className="customer-delivery-payment-select" options={[{ value: "paid", label: "接入费" }, { value: "unpaid", label: "赠送" }]} /></Form.Item>
            <Form.Item name="paymentDate" label="付款时间" rules={[{ required: true, message: "请选择付款日期" }]}><DatePicker classNames={{ popup: { root: "customer-delivery-date-popup" } }} format="YYYY-MM-DD" placeholder="请选择付款日期" style={{ width: "100%" }} /></Form.Item>
            <Form.Item label="合同文件或链接" required>
              <Form.Item name="contractFile" noStyle rules={[{ required: true, message: "请上传合同或填写合同链接" }]}>
                <Input placeholder="" suffix={<Button type="text" className="customer-delivery-upload-button" aria-label="上传合同文件" title="上传合同文件" icon={<UploadOutlined />} onClick={() => contractFileInput.current?.click()} />} />
              </Form.Item>
              <input ref={contractFileInput} hidden type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" onChange={(event) => { const file = event.target.files?.[0]; if (file) { createForm.setFieldValue("contractFile", file.name); setUploadedContractName(file.name); setUploadedContractFile(file); setCreateDraftDirty(true); } }} />
              {uploadedContractName ? <div className="customer-delivery-uploaded-file">已选择：{uploadedContractName}<Button type="text" size="small" className="customer-delivery-clear-upload" aria-label="取消已选合同文件" title="取消已选文件" icon={<CloseOutlined />} onClick={() => { createForm.setFieldValue("contractFile", ""); setUploadedContractName(""); setUploadedContractFile(undefined); if (contractFileInput.current) contractFileInput.current.value = ""; }} /></div> : null}
            </Form.Item>
            <Form.Item name="owner" label="项目负责人" rules={[{ required: true, message: "请输入项目负责人" }]}><Input placeholder="例如：姜伟" /></Form.Item>
            <Form.Item name="afterSalesOwner" label="售后负责人" rules={[{ required: true, message: "请输入售后负责人" }]}><Input placeholder="例如：韩先晓" /></Form.Item>
            </div>
        </Card>
        <div className="customer-delivery-check-card-row">
        <Card title={<span>系统接入确认 <em className="customer-delivery-required-mark">*</em></span>}>
          <div className="customer-delivery-check-grid customer-delivery-check-grid-five">
            {INTEGRATION_ITEMS.map((itemKey) => { const label = checklistDisplayLabel(itemKey); return (
              <label className="customer-delivery-check-item" key={itemKey}><span>{label === "创作点" || label === "商品资料" ? `${label}\u00a0` : label}</span><Checkbox checked={integrationChecks.includes(itemKey)} onChange={(event) => { setCreateDraftDirty(true); setIntegrationChecks((current) => event.target.checked ? [...current, itemKey] : current.filter((item) => item !== itemKey)); }} /></label>
            ); })}
          </div>
        </Card>
        <Card title={<span>功能测试及验收 <em className="customer-delivery-required-mark">*</em></span>}>
          <div className="customer-delivery-check-grid customer-delivery-check-grid-four">
            {ACCEPTANCE_ITEMS.map((itemKey) => <label className="customer-delivery-check-item" key={itemKey}><span className={itemKey === "店铺/商品读取" ? "customer-delivery-four-char-label" : undefined}>{checklistDisplayLabel(itemKey)}</span><Checkbox checked={acceptanceChecks.includes(itemKey)} onChange={(event) => { setCreateDraftDirty(true); setAcceptanceChecks((current) => event.target.checked ? [...current, itemKey] : current.filter((item) => item !== itemKey)); }} /></label>)}
          </div>
        </Card>
        </div>
        {mutationError ? <div ref={createErrorRef} className="customer-delivery-create-error" tabIndex={-1}><Alert type="error" showIcon title="创建客户失败" description={mutationError} /></div> : null}
        <div className="customer-delivery-create-actions">
          <Button disabled={creating} onClick={() => { setCreateDraftDirty(false); setCreatePage(false); }}>返回客户建档</Button>
          <Space>
            <Button type="primary" htmlType="submit" form="customer-create-form" loading={creating}>{creating ? "正在创建" : "创建客户"}</Button>
          </Space>
        </div>
        </Form>
        </>
      ) : <CustomerDeliverySection
        key={targetWorkspaceId || "unselected"}
        disabled={!canRead || !targetWorkspaceId}
        readOnly={canRead && !canUpdate}
        records={records}
        onCreate={canUpdate && canRead ? createRecord : undefined}
        onCreateNavigate={canUpdate && canRead ? () => { setMutationError(""); pendingCreate.current = undefined; setCreateDraftDirty(false); setCreatePage(true); } : undefined}
        onSave={canUpdate && canRead ? saveProfile : undefined}
        onChecklistSave={canUpdate && canRead ? saveChecklist : undefined}
        onChecklistLoad={loadChecklist}
        onTrainingSave={canUpdate && canRead ? saveTraining : undefined}
        onAccountList={canUpdate && canRead ? async (input, signal) => {
          signal.throwIfAborted();
          if (!hasCurrentReadAccess(targetWorkspaceId) || !currentCanUpdate.current) throw new DOMException("账号查询权限已变更", "AbortError");
          const result = await customerDeliveryClient.listAccounts({ targetWorkspaceId, ...input }, signal);
          signal.throwIfAborted();
          if (!hasCurrentReadAccess(targetWorkspaceId) || !currentCanUpdate.current) throw new DOMException("账号查询范围已变更", "AbortError");
          return result;
        } : undefined}
        onAccountBind={canUpdate && canRead ? async (record, account, reason, signal) => {
          signal.throwIfAborted();
          if (!hasCurrentReadAccess(targetWorkspaceId) || !currentCanUpdate.current) throw new DOMException("账号关联权限已变更", "AbortError");
          if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) throw new Error("档案版本无效，请刷新后再关联账号");
          if (account.workspaceId !== targetWorkspaceId) throw new Error("所选账号不属于当前企业，请重新查询");
          const updated = await customerDeliveryClient.bindAccount({ targetWorkspaceId, deliveryId: record.id, targetAccountId: account.accountId, reason, expectedRevision: record.revision as number }, signal);
          signal.throwIfAborted();
          if (!hasCurrentReadAccess(targetWorkspaceId) || !currentCanUpdate.current) throw new DOMException("账号关联范围已变更", "AbortError");
          if (updated.targetIdentityId !== account.identityId) throw new Error("关联响应与所选账号身份不一致，请刷新档案核对");
          setRecords((previous) => previous.map((candidate) => candidate.id === record.id ? updated : candidate));
          return updated;
        } : undefined}
        onAssetUpload={canUpdate && canRead ? (record, source, purpose, signal) => {
          if ("sourceUrl" in source) {
            if (purpose !== "contract") return Promise.reject(new Error("仅合同凭证支持链接导入"));
            return customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: record.id, sourceUrl: source.sourceUrl, purpose }, signal);
          }
          return customerDeliveryClient.uploadAsset({ targetWorkspaceId, deliveryId: record.id, file: source, purpose }, signal);
        } : undefined}
        onAssetGet={(record, assetRef, purpose, signal) => customerDeliveryClient.getAsset({ targetWorkspaceId, deliveryId: record.id, assetRef, purpose }, signal)}
        onAssetOpen={openDeliveryAsset}
        onArchive={canUpdate && canRead ? archiveRecord : undefined}
        operatorActorId={model.opsSession?.actor_id}
        operatorName={accountLabel(model.opsSession)}
      />}
    </OpsPage>
  );
}
