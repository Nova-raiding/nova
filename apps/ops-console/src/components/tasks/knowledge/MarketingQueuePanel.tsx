import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Card, Descriptions, Empty, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import { parseRevisionChangesJson, type RevisionCreationValues } from "./revisionCreation.js";
import { describeOpsError, rpc } from "../../../api/opsClient.js";
import { CampaignLifecycleControl } from './CampaignLifecycleControl.js'
import { assetScanRecoveryEvidence } from "./assetScanRecovery.js";

interface MarketingQueuePanelProps {
  model: OpsConsoleModel;
}

interface QueueRow {
  id: string;
  kind: string;
  taskId: string;
  state: string;
  detail: string;
  updatedAt: string;
  action: ReactNode;
}

export interface PublishBatchDetail {
  id: string;
  state: string;
  pauseReason?: string;
  items: Array<{ taskId: string; productId?: string; platform?: string; accountId?: string; contentVersionId?: string; state: string; error?: { code?: string; message?: string } }>;
}

export function visualEvidenceState(reviewStatus: string) {
  return reviewStatus === "blocked" ? "blocked" : "evidence_unverified";
}

export function publishBatchItemScope(item: PublishBatchDetail["items"][number]) {
  return {
    platform: item.platform ?? null,
    accountId: item.accountId ?? null,
    productId: item.productId ?? null,
    taskId: item.taskId,
    state: item.state,
  };
}

export function publishBatchItemKey(item: PublishBatchDetail["items"][number]) {
  return JSON.stringify([item.taskId, item.platform ?? null, item.accountId ?? null, item.productId ?? null, item.contentVersionId ?? null]);
}

export function parsePublishBatchDetail(value: unknown): PublishBatchDetail {
  if (!value || typeof value !== "object") throw new Error("批次详情响应格式无效");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.state !== "string" || !Array.isArray(candidate.items)) throw new Error("批次详情缺少 id、state 或 items");
  const items = candidate.items.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`批次项目 ${index + 1} 格式无效`);
    const item = value as Record<string, unknown>;
    if (typeof item.taskId !== "string" || typeof item.state !== "string") throw new Error(`批次项目 ${index + 1} 缺少 taskId 或 state`);
    const optionalString = (key: string) => typeof item[key] === "string" ? item[key] as string : undefined;
    const rawError = item.error;
    const error = rawError && typeof rawError === "object"
      ? { code: typeof (rawError as Record<string, unknown>).code === "string" ? (rawError as Record<string, unknown>).code as string : undefined, message: typeof (rawError as Record<string, unknown>).message === "string" ? (rawError as Record<string, unknown>).message as string : undefined }
      : undefined;
    return { taskId: item.taskId, state: item.state, productId: optionalString("productId"), platform: optionalString("platform"), accountId: optionalString("accountId"), contentVersionId: optionalString("contentVersionId"), error };
  });
  return { id: candidate.id, state: candidate.state, pauseReason: typeof candidate.pauseReason === "string" ? candidate.pauseReason : undefined, items };
}

function stateColor(state: string) {
  if (
    ["failed", "rejected", "unknown", "outcome_unknown", "manual_attention", "blocked"].includes(
      state,
    )
  )
    return "red";
  if (
    ["succeeded", "published", "completed", "passed", "ready"].includes(state)
  )
    return "green";
  return "orange";
}

export function queueStateLabel(state: string) {
  return ({
    queued: "排队中",
    running: "处理中",
    processing: "处理中",
    archiving: "归档中",
    scanning: "安全扫描中",
    provider_reserved: "生成请求已登记，等待提交",
    provider_dispatching: "正在提交模型请求，等待受理确认",
    dispatching: "正在提交模型请求，等待受理确认",
    provider_started: "模型已受理，等待结果确认",
    failed: "失败",
    rejected: "已驳回",
    unknown: "待对账",
    outcome_unknown: "结果待对账",
    manual_attention: "待人工处理",
    blocked: "已阻断",
    succeeded: "已完成",
    completed: "已完成",
    published: "已发布",
    ready: "待处理",
  } as Record<string, string>)[state] ?? "状态待确认";
}

export function MarketingQueuePanel({ model }: MarketingQueuePanelProps) {
  const { message } = App.useApp();
  const {
    acknowledgePublish,
    assignQueueItem,
    createRevision,
    marketingQueue,
    pausePublishBatch,
    resumePublishBatch,
    retryFailedPublishBatch,
    retryGeneration,
    reviewVisual,
    reconcileImageExecution,
  } = model;
  const [revisionForm] = Form.useForm<RevisionCreationValues>();
  const [revisionTarget, setRevisionTarget] = useState<OpsConsoleModel["marketingQueue"]["publish"][number]>();
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState("");
  const [assignmentForm] = Form.useForm<{ operatorId: string }>();
  const [assignmentTarget, setAssignmentTarget] = useState<{ itemType: "generation" | "publish" | "image"; itemId: string; revision: number; currentOperator?: string | null }>();
  const [assignmentSubmitting, setAssignmentSubmitting] = useState(false);
  const [batchDecision, setBatchDecision] = useState<{
    action: "pause" | "resume" | "retry";
    batch: OpsConsoleModel["marketingQueue"]["batches"][number];
  }>();
  const [batchReason, setBatchReason] = useState("");
  const [batchConfirmations, setBatchConfirmations] = useState("");
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchError, setBatchError] = useState("");
  const batchSubmitLockRef = useRef(false);
  const batchDetailRequestRef = useRef(0);
  const batchDetailRegionRef = useRef<HTMLDivElement>(null);
  const [batchDetail, setBatchDetail] = useState<PublishBatchDetail>();
  const [batchDetailTarget, setBatchDetailTarget] = useState("");
  const [batchDetailLoading, setBatchDetailLoading] = useState(false);
  const [batchDetailError, setBatchDetailError] = useState("");
  const [imageEvidenceTarget, setImageEvidenceTarget] = useState<OpsConsoleModel["marketingQueue"]["imageExecutions"][number]>();
  const [imageEvidenceExporting, setImageEvidenceExporting] = useState(false);
  const [imageReconcileTarget, setImageReconcileTarget] = useState<OpsConsoleModel["marketingQueue"]["imageExecutions"][number]>();
  const [imageResolution, setImageResolution] = useState<"completed" | "failed">("failed");
  const [imageReason, setImageReason] = useState("");
  const [imageEvidenceRef, setImageEvidenceRef] = useState("");
  const [imageReconcileSubmitting, setImageReconcileSubmitting] = useState(false);
  const [visualReviewTarget, setVisualReviewTarget] = useState<{
    visual: OpsConsoleModel["marketingQueue"]["visuals"][number];
    status: "passed" | "blocked";
  }>();
  const [visualEvidenceTarget, setVisualEvidenceTarget] = useState<OpsConsoleModel["marketingQueue"]["visuals"][number]>();
  const [visualReviewReason, setVisualReviewReason] = useState("");
  const [visualReviewSubmitting, setVisualReviewSubmitting] = useState(false);
  const revisionErrorRef = useRef<HTMLDivElement>(null);

  const exportImageEvidence = async () => {
    if (!imageEvidenceTarget) return;
    setImageEvidenceExporting(true);
    try {
      const response = await rpc("ops.marketing.image.evidence.export", { job_id: imageEvidenceTarget.jobId }) as { fileName?: string; contentType?: string; json?: string };
      if (typeof response.json !== "string") throw new Error("证据包响应格式无效");
      const blob = new Blob([response.json], { type: response.contentType ?? "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = response.fileName ?? `image-evidence-${imageEvidenceTarget.jobId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "图片证据包导出失败");
    } finally {
      setImageEvidenceExporting(false);
    }
  };

  useEffect(() => {
    if (revisionError) revisionErrorRef.current?.focus();
  }, [revisionError]);

  useEffect(() => {
    if (!batchDetailLoading && (batchDetail || batchDetailError)) batchDetailRegionRef.current?.focus();
  }, [batchDetail, batchDetailError, batchDetailLoading]);

  const closeRevisionModal = () => {
    if (revisionSubmitting) return;
    setRevisionTarget(undefined);
    setRevisionError("");
    revisionForm.resetFields();
  };

  const submitRevision = async (values: RevisionCreationValues) => {
    if (!revisionTarget) return;
    setRevisionSubmitting(true);
    setRevisionError("");
    try {
      const result = await createRevision(revisionTarget, values);
      if (result.ok) {
        setRevisionTarget(undefined);
        revisionForm.resetFields();
        return;
      }
      setRevisionError(result.error);
    } finally {
      setRevisionSubmitting(false);
    }
  };
  const openAssignment = (target: { itemType: "generation" | "publish" | "image"; itemId: string; revision: number; currentOperator?: string | null }) => {
    assignmentForm.setFieldsValue({ operatorId: target.currentOperator ?? "" });
    setAssignmentTarget(target);
  };
  const closeAssignment = () => { if (!assignmentSubmitting) { setAssignmentTarget(undefined); assignmentForm.resetFields(); } };
  const openVisualReview = (visual: OpsConsoleModel["marketingQueue"]["visuals"][number], status: "passed" | "blocked") => {
    setVisualReviewTarget({ visual, status });
    setVisualReviewReason("");
  };
  const closeVisualReview = () => {
    if (visualReviewSubmitting) return;
    setVisualReviewTarget(undefined);
    setVisualReviewReason("");
  };
  const submitVisualReview = async () => {
    if (!visualReviewTarget || visualReviewReason.trim().length < 4) return;
    setVisualReviewSubmitting(true);
    try {
      await reviewVisual(visualReviewTarget.visual, visualReviewTarget.status, visualReviewReason);
      setVisualReviewTarget(undefined);
      setVisualReviewReason("");
    } finally {
      setVisualReviewSubmitting(false);
    }
  };
  const submitAssignment = async (values: { operatorId: string }) => {
    if (!assignmentTarget) return;
    setAssignmentSubmitting(true);
    const saved = await assignQueueItem(assignmentTarget.itemType, assignmentTarget.itemId, assignmentTarget.revision, values.operatorId);
    setAssignmentSubmitting(false);
    if (saved) closeAssignment();
  };
  const closeImageReconcile = () => { if (!imageReconcileSubmitting) { setImageReconcileTarget(undefined); setImageReason(""); setImageEvidenceRef(""); setImageResolution("failed"); } };
  const submitImageReconcile = async () => {
    if (!imageReconcileTarget || imageReason.trim().length < 4 || !imageEvidenceRef.trim()) return;
    setImageReconcileSubmitting(true);
    try {
      if (await reconcileImageExecution({ jobId: imageReconcileTarget.jobId, resolution: imageResolution, evidenceRef: imageEvidenceRef, reason: imageReason, revision: imageReconcileTarget.revision })) closeImageReconcile();
    } finally { setImageReconcileSubmitting(false); }
  };
  const openBatchDecision = (
    action: "pause" | "resume" | "retry",
    batch: OpsConsoleModel["marketingQueue"]["batches"][number],
  ) => {
    setBatchDecision({ action, batch });
    setBatchReason("");
    setBatchConfirmations("");
    setBatchError("");
  };
  const closeBatchDecision = () => {
    if (batchSubmitting) return;
    setBatchDecision(undefined);
    setBatchReason("");
    setBatchConfirmations("");
    setBatchError("");
  };
  const loadBatchDetail = async (batchId: string) => {
    const requestId = ++batchDetailRequestRef.current;
    setBatchDetailLoading(true);
    setBatchDetailTarget(batchId);
    setBatchDetailError("");
    try {
      const result = parsePublishBatchDetail(await rpc("publish.batch.get", { batch_id: batchId }));
      if (requestId === batchDetailRequestRef.current) setBatchDetail(result);
    } catch (cause) {
      if (requestId === batchDetailRequestRef.current) { setBatchDetail(undefined); setBatchDetailError(describeOpsError(cause)); }
    } finally {
      if (requestId === batchDetailRequestRef.current) setBatchDetailLoading(false);
    }
  };
  const submitBatchDecision = async () => {
    if (!batchDecision || batchSubmitLockRef.current) return;
    if (batchDecision.action === "pause" && batchReason.trim().length < 4) {
      setBatchError("暂停原因至少填写 4 个字符");
      return;
    }
    if (batchDecision.action === "retry" && !batchConfirmations.trim()) {
      setBatchError("请填写失败项的新确认 JSON");
      return;
    }
    batchSubmitLockRef.current = true;
    setBatchSubmitting(true);
    setBatchError("");
    try {
      const succeeded = batchDecision.action === "pause"
        ? await pausePublishBatch(batchDecision.batch, batchReason)
        : batchDecision.action === "resume"
          ? await resumePublishBatch(batchDecision.batch)
          : await retryFailedPublishBatch(batchDecision.batch, batchConfirmations);
      if (succeeded) {
        setBatchDecision(undefined);
        setBatchReason("");
        setBatchConfirmations("");
      } else {
        setBatchError("操作未完成，输入已保留；请核对原因或确认数据后重试。");
      }
    } finally {
      batchSubmitLockRef.current = false;
      setBatchSubmitting(false);
    }
  };

  const rows: QueueRow[] = [
    ...marketingQueue.batches.map((batch) => ({
      id: `batch:${batch.id}`,
      kind: "批量发布",
      taskId: `${batch.itemCount} 个商品`,
      state: batch.state,
      detail: `已排队 ${batch.queuedCount}，失败 ${batch.failedCount}${batch.pauseReason ? `；暂停：${batch.pauseReason}` : ""}`,
      updatedAt: batch.updatedAt,
      action: (
        <Space wrap>
          <Button type="link" onClick={() => void loadBatchDetail(batch.id)}>查看逐项状态</Button>
          {batch.state === "paused" ? (
            <Button type="link" onClick={() => openBatchDecision("resume", batch)}>确认恢复</Button>
          ) : !["completed", "failed"].includes(batch.state) ? (
            <Button type="link" danger onClick={() => openBatchDecision("pause", batch)}>暂停后续操作</Button>
          ) : null}
          {batch.failedCount > 0 && batch.state !== "paused" && (
            <Button type="link" onClick={() => openBatchDecision("retry", batch)}>带新确认重试失败项</Button>
          )}
        </Space>
      ),
    })),
    ...marketingQueue.generation.map((job) => ({
      id: `generation:${job.id}`,
      kind: "文案生成",
      taskId: job.taskId,
      state: job.state,
      detail: `${job.assignedOperatorId ? `负责人：${job.assignedOperatorId}；` : "未分配负责人；"}${job.errorCode || job.errorMessage || `重试 ${job.attempt} 次`}`,
      updatedAt: job.updatedAt,
      action: (
        <Space>
          {job.state === "failed" && (
            <Button type="link" onClick={() => void retryGeneration(job)}>
              安全重试
            </Button>
          )}
          <Button
            type="link"
            onClick={() =>
              openAssignment({ itemType: "generation", itemId: job.id, revision: job.revision, currentOperator: job.assignedOperatorId })
            }
          >
            分配负责人
          </Button>
        </Space>
      ),
    })),
    ...marketingQueue.publish.map((job) => ({
      id: `publish:${job.id}`,
      kind: `发布 · ${job.platform}`,
      taskId: job.taskId,
      state: job.remoteState || job.state,
      detail: `${job.assignedOperatorId ? `负责人：${job.assignedOperatorId}；` : "未分配负责人；"}${job.rejection?.rawCode || job.rejection?.message || "等待平台回执"}`,
      updatedAt: job.createdAt,
      action: (
        <Space wrap>
          <Button
            type="link"
            onClick={() =>
              openAssignment({ itemType: "publish", itemId: job.id, revision: job.revision, currentOperator: job.assignedOperatorId })
            }
          >
            分配负责人
          </Button>
          {["rejected", "unknown", "manual_attention"].includes(
            job.remoteState || job.state,
          ) && (
            <>
              <Button type="link" onClick={() => void acknowledgePublish(job)}>
                确认异常
              </Button>
              {(job.remoteState === "rejected" || job.state === "rejected") && (
                <Button type="link" onClick={() => { setRevisionError(""); revisionForm.resetFields(); setRevisionTarget(job); }}>
                  创建修正版
                </Button>
              )}
            </>
          )}
        </Space>
      ),
    })),
    ...marketingQueue.visuals.map((visual) => ({
      id: `visual:${visual.visualRef}`,
      kind: "视觉候选",
      taskId: visual.taskId ?? visual.productId,
      state: visualEvidenceState(visual.reviewStatus),
      detail: `人工画面状态：${visual.reviewStatus}；真实性证据未返回。SKU：${visual.skuIds.join(", ") || "全 SKU"}；候选 ${visual.ordinal}；${visual.assignedOperatorId ? `负责人：${visual.assignedOperatorId}` : "未分配负责人"}`,
      updatedAt: visual.updatedAt,
      action: (
        <Space wrap>
          <Button
            type="link"
            aria-label={`查看视觉候选 ${visual.ordinal} 的证据详情`}
            onClick={() => setVisualEvidenceTarget(visual)}
          >
            查看候选详情
          </Button>
          <Button
            type="link"
            onClick={() => openVisualReview(visual, "passed")}
          >
            人工画面通过（非真实性）
          </Button>
          <Button
            type="link"
            danger
            onClick={() => openVisualReview(visual, "blocked")}
          >
            阻断
          </Button>
        </Space>
      ),
    })),
    ...marketingQueue.imageExecutions.map((execution) => ({
      id: `image-execution:${execution.jobId}`,
      kind: "图片执行对账",
      taskId: execution.taskId ?? execution.jobId,
      state: execution.state,
      detail: `${execution.assignedOperatorId ? `负责人：${execution.assignedOperatorId}；` : "未分配负责人；"}告警：${execution.alertState === "open" ? "超时待处理" : "观察中"}；最后动作：${execution.lastAction}；归档：${execution.archiveState}；Provider 请求：${execution.providerRequestId ?? "尚未确认"}；对账：${execution.reconciliationStatus ?? "未收口"}${execution.reconciliationEvidenceRef ? `（${execution.reconciliationEvidenceRef}）` : ""}；attempt ${execution.attempt}；${execution.errorMessage ?? execution.reconciliationReason ?? execution.nextAction}`,
      updatedAt: execution.updatedAt,
      action: <Space wrap><Button type="link" onClick={() => setImageEvidenceTarget(execution)} aria-label={`查看图片任务 ${execution.jobId} 的执行证据`}>查看执行证据</Button>{["unknown", "outcome_unknown", "manual_attention"].includes(execution.state) || execution.reconciliationStatus === "required" ? <Button type="link" onClick={() => { setImageReconcileTarget(execution); setImageResolution("failed"); setImageReason(""); setImageEvidenceRef(""); }}>打开对账</Button> : <Typography.Text type="secondary">仅观测，不可重复生成</Typography.Text>}<Button type="link" onClick={() => openAssignment({ itemType: "image", itemId: execution.jobId, revision: execution.revision, currentOperator: execution.assignedOperatorId })}>分配负责人</Button></Space>,
    })),
    ...marketingQueue.uploadedAssetRisks.map((asset) => {
      const recovery = assetScanRecoveryEvidence(asset, marketingQueue.assetScanFailures);
      const deadLetterDetail = recovery.eventId
        ? `；扫描死信 event_id ${recovery.eventId}；错误 ${recovery.errorCode ?? "SCAN_FAILED"}${recovery.errorMessage ? ` · ${recovery.errorMessage}` : ""}；retryable ${recovery.retryable === true ? "true" : recovery.retryable === false ? "false" : "未返回"}；revision ${recovery.assetRevision ?? "未返回"}`
        : "；扫描死信证据未返回，保持禁止人工重试";
      return {
        id: `uploaded-asset:${asset.id}`,
        kind: "上传素材",
        taskId: asset.name,
        state: asset.readiness.status,
        detail: `${asset.readiness.reasons.join("；") || "待处理"}${deadLetterDetail}；下一步：${asset.nextAction?.label ?? asset.nextStep ?? "联系安全审核"}`,
        updatedAt: asset.createdAt,
        action: <Typography.Text type="secondary">请在下方“上传素材治理动作”核对并处理</Typography.Text>,
      };
    }),
  ];

  return (
    <>
      <CampaignLifecycleControl canControl={model.canQueue}/>
      <Table
      rowKey="id"
      pagination={{ pageSize: 8 }}
      dataSource={rows}
      columns={[
        { title: "类型", dataIndex: "kind" },
        { title: "任务", dataIndex: "taskId" },
        {
          title: "状态",
          dataIndex: "state",
            render: (value: string) => (
            <Tag color={stateColor(value)} aria-label={`状态：${queueStateLabel(value)}`}>{queueStateLabel(value)}</Tag>
          ),
        },
        { title: "原因/下一步", dataIndex: "detail" },
        {
          title: "时间",
          dataIndex: "updatedAt",
          render: (value: string) => new Date(value).toLocaleString(),
        },
        { title: "操作", dataIndex: "action" },
      ]}
      />
      <Modal
        open={Boolean(visualEvidenceTarget)}
        title="视觉候选证据详情"
        footer={null}
        onCancel={() => setVisualEvidenceTarget(undefined)}
        destroyOnHidden
      >
        {visualEvidenceTarget && <>
          <Alert
            type="warning"
            showIcon
            role="status"
            aria-live="polite"
            title="人工画面审查不等于安全或真实性通过"
            description="候选仍须满足归档、恶意内容扫描、权益和真实性证据门禁；未满足前不得选择主图、下载或发布。"
          />
          <Descriptions column={1} size="small" bordered style={{ marginTop: 16 }}>
            <Descriptions.Item label="候选序号">{visualEvidenceTarget.ordinal}</Descriptions.Item>
            <Descriptions.Item label="候选引用">{visualEvidenceTarget.visualRef}</Descriptions.Item>
            <Descriptions.Item label="商品 / 任务">{visualEvidenceTarget.productId} / {visualEvidenceTarget.taskId ?? "未绑定任务"}</Descriptions.Item>
            <Descriptions.Item label="内容版本">{visualEvidenceTarget.contentVersionId ?? "未返回"}</Descriptions.Item>
            <Descriptions.Item label="SKU 范围">{visualEvidenceTarget.skuIds.join(", ") || "全 SKU"}</Descriptions.Item>
            <Descriptions.Item label="人工画面状态"><Tag color={stateColor(visualEvidenceTarget.reviewStatus)} aria-label={`人工画面状态：${visualEvidenceTarget.reviewStatus}`}>{visualEvidenceTarget.reviewStatus}</Tag></Descriptions.Item>
            <Descriptions.Item label="真实性证据">未返回，保持不可选择</Descriptions.Item>
            <Descriptions.Item label="更新时间">{new Date(visualEvidenceTarget.updatedAt).toLocaleString()}</Descriptions.Item>
          </Descriptions>
        </>}
      </Modal>
      <Modal open={Boolean(imageEvidenceTarget)} title="图片执行证据" footer={imageEvidenceTarget ? <Button loading={imageEvidenceExporting} onClick={() => void exportImageEvidence()}>导出脱敏证据包</Button> : null} onCancel={() => setImageEvidenceTarget(undefined)} destroyOnHidden>
        {imageEvidenceTarget && <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Job ID">{imageEvidenceTarget.jobId}</Descriptions.Item>
          <Descriptions.Item label="Task / Product">{imageEvidenceTarget.taskId ?? "未绑定任务"} / {imageEvidenceTarget.productId}</Descriptions.Item>
          <Descriptions.Item label="执行状态"><Tag color={stateColor(imageEvidenceTarget.state)}>{queueStateLabel(imageEvidenceTarget.state)}</Tag></Descriptions.Item>
          <Descriptions.Item label="归档状态">{imageEvidenceTarget.archiveState}</Descriptions.Item>
          <Descriptions.Item label="执行尝试">{imageEvidenceTarget.attempt}</Descriptions.Item>
          <Descriptions.Item label="Provider request ID">{imageEvidenceTarget.providerRequestId ?? "尚未确认"}</Descriptions.Item>
          <Descriptions.Item label="请求事件 ID">{imageEvidenceTarget.eventId}</Descriptions.Item>
          <Descriptions.Item label="错误">{imageEvidenceTarget.errorCode ?? "无"}{imageEvidenceTarget.errorMessage ? `：${imageEvidenceTarget.errorMessage}` : ""}</Descriptions.Item>
          <Descriptions.Item label="下一步">{["unknown", "outcome_unknown", "manual_attention"].includes(imageEvidenceTarget.state) || imageEvidenceTarget.reconciliationStatus === "required" ? "打开对账并提供证据；禁止重复生成" : imageEvidenceTarget.nextAction}</Descriptions.Item>
          <Descriptions.Item label="告警/最后动作">{imageEvidenceTarget.alertState === "open" ? "超时待处理" : "观察中"} · {imageEvidenceTarget.lastAction}</Descriptions.Item>
          <Descriptions.Item label="关闭依据">{imageEvidenceTarget.closureEvidence ?? "尚未关闭"}</Descriptions.Item>
          <Descriptions.Item label="对账状态">{imageEvidenceTarget.reconciliationStatus ?? "未收口"} · revision {imageEvidenceTarget.reconciliationRevision ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="对账证据">{imageEvidenceTarget.reconciliationEvidenceRef ?? "未提供"}</Descriptions.Item>
          <Descriptions.Item label="对账原因">{imageEvidenceTarget.reconciliationReason ?? "未提供"}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{new Date(imageEvidenceTarget.updatedAt).toLocaleString()}</Descriptions.Item>
        </Descriptions>}
      </Modal>
      <Modal open={Boolean(imageReconcileTarget)} title="人工收口图片执行" okText="提交收口" cancelText="取消" confirmLoading={imageReconcileSubmitting} okButtonProps={{ danger: imageResolution === "failed", disabled: imageReason.trim().length < 4 || !imageEvidenceRef.trim() }} onCancel={closeImageReconcile} onOk={() => void submitImageReconcile()} destroyOnHidden>
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Alert type="warning" showIcon role="alert" title="未知状态不能直接视为成功或重试" description="完成收口仅在服务端确认任务成功、产物已归档且安全扫描通过时允许；失败收口必须留下可追溯证据。收口期间 Merchant 与 Ops 都不会创建第二个 Provider 请求。" />
          <Typography.Text type="secondary">{imageReconcileTarget ? `${imageReconcileTarget.jobId} · revision ${imageReconcileTarget.revision}` : ""}</Typography.Text>
          <Select aria-label="图片收口结果" value={imageResolution} onChange={setImageResolution} options={[{ value: "failed", label: "确认失败" }, { value: "completed", label: "确认完成（需产物门禁通过）" }]} style={{ width: "100%" }} />
          <Input aria-label="图片收口证据引用" value={imageEvidenceRef} onChange={(event) => setImageEvidenceRef(event.target.value)} placeholder="证据引用：工单、Provider 查询记录或审计附件 ID" maxLength={500} />
          <Input.TextArea aria-label="图片收口原因" value={imageReason} onChange={(event) => setImageReason(event.target.value)} placeholder="填写人工判断依据（至少 4 个字符）" maxLength={500} showCount rows={4} />
        </Space>
      </Modal>
      <Modal
        open={Boolean(visualReviewTarget)}
        title={visualReviewTarget?.status === "passed" ? "确认视觉候选通过" : "确认阻断视觉候选"}
        okText={visualReviewTarget?.status === "passed" ? "提交通过" : "提交阻断"}
        cancelText="取消"
        confirmLoading={visualReviewSubmitting}
        okButtonProps={{ danger: visualReviewTarget?.status === "blocked", disabled: visualReviewReason.trim().length < 4 }}
        onCancel={closeVisualReview}
        onOk={() => void submitVisualReview()}
        destroyOnHidden
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {visualReviewTarget ? `候选 ${visualReviewTarget.visual.ordinal} · ${visualReviewTarget.visual.visualRef} · revision ${visualReviewTarget.visual.revision}` : ""}
          </Typography.Text>
          <Alert
            showIcon
            type={visualReviewTarget?.status === "passed" ? "warning" : "error"}
            title={visualReviewTarget?.status === "passed" ? "此动作只代表人工画面审查通过" : "阻断后候选不可进入选图链路"}
            description="真实性、扫描、权益和发布门禁仍由服务端独立判断；版本变化时提交会被拒绝。"
          />
          <Input.TextArea
            aria-label="视觉审核原因"
            value={visualReviewReason}
            onChange={(event) => setVisualReviewReason(event.target.value)}
            placeholder="填写本次审核依据（至少 4 个字符）"
            maxLength={300}
            showCount
            autoFocus
            rows={4}
          />
        </Space>
      </Modal>
      <div className="ops-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{batchDetailLoading ? "正在读取批次逐项状态" : batchDetailError ? "批次逐项状态读取失败" : batchDetail ? `已读取批次 ${batchDetail.id} 的 ${batchDetail.items.length} 个项目` : ""}</div>
      {(batchDetailLoading || batchDetailError || batchDetail) && <div ref={batchDetailRegionRef} className="ops-batch-detail-region" tabIndex={-1}><Card size="small" className="ops-batch-detail" title={batchDetail ? `批次 ${batchDetail.id} · 逐项状态` : "批次逐项状态"} extra={batchDetail ? <Button type="link" onClick={() => { batchDetailRequestRef.current += 1; setBatchDetail(undefined); setBatchDetailTarget(""); setBatchDetailError(""); setBatchDetailLoading(false); }}>关闭</Button> : undefined}>
        {batchDetailLoading && <Typography.Text type="secondary">正在按平台、店铺和任务读取逐项状态…</Typography.Text>}
        {batchDetailError && <Alert type="error" showIcon role="alert" title="批次详情读取失败" description={batchDetailError} action={<Button onClick={() => { if (batchDetailTarget) void loadBatchDetail(batchDetailTarget); }}>重试</Button>} />}
        {batchDetail && batchDetail.items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="服务端返回空批次；没有任何项目可安全操作"/>}
        {batchDetail && batchDetail.items.length > 0 && <Table rowKey={publishBatchItemKey} pagination={false} scroll={{ x: 760 }} dataSource={batchDetail.items} columns={[
          { title: "平台", dataIndex: "platform", render: (value?: string) => value ?? <Typography.Text type="danger">未返回</Typography.Text> },
          { title: "店铺账号", dataIndex: "accountId", render: (value?: string) => value ?? <Typography.Text type="danger">未绑定</Typography.Text> },
          { title: "商品 / 任务", render: (_: unknown, item: PublishBatchDetail["items"][number]) => <div><b>{item.productId ?? "商品 ID 未返回"}</b><br/><Typography.Text type="secondary">{item.taskId}</Typography.Text></div> },
          { title: "状态", dataIndex: "state", render: (value: string) => <Tag color={stateColor(value)} aria-label={`状态：${queueStateLabel(value)}`}>{queueStateLabel(value)}</Tag> },
          { title: "错误 / 下一步", render: (_: unknown, item: PublishBatchDetail["items"][number]) => item.error ? `${item.error.code ?? "ITEM_FAILED"} · ${item.error.message ?? "人工核对后重试"}` : item.state === "failed" ? "缺少结构化错误；禁止自动重试" : "继续观测独立平台回执" },
        ]}/>}
      </Card></div>}
      <Modal
        title="创建发布修正版"
        open={Boolean(revisionTarget)}
        okText="创建并进入审核"
        cancelText="取消"
        confirmLoading={revisionSubmitting}
        onCancel={closeRevisionModal}
        onOk={() => revisionForm.submit()}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {revisionTarget ? `${revisionTarget.platform} · ${revisionTarget.id} · ${revisionTarget.rejection?.message ?? revisionTarget.rejection?.rawCode ?? "平台驳回"}` : ""}
          </Typography.Text>
          {revisionError && (
            <div ref={revisionErrorRef} tabIndex={-1} role="alert">
              <Alert
                type="error"
                showIcon
                title="创建修正版失败"
                description={`${revisionError}。请修正后重试。`}
              />
            </div>
          )}
          <Form
            form={revisionForm}
            layout="vertical"
            requiredMark
            aria-label="发布修正版变更表单"
            onFinish={(values) => void submitRevision(values)}
            onFinishFailed={({ errorFields }) => {
              const first = errorFields[0]?.name;
              if (first) revisionForm.scrollToField(first, { block: "center", focus: true });
            }}
          >
            <Form.Item
              name="changesJson"
              label="变更内容 JSON"
              extra={'填写非空 JSON 对象，例如 {"title":"合规新标题"}。不会修改原发布版本。'}
              rules={[
                { required: true, whitespace: true, message: "请填写修正版变更 JSON" },
                { validator: async (_rule, value: string | undefined) => { if (!value?.trim()) return; parseRevisionChangesJson(value); } },
              ]}
            >
              <Input.TextArea className="ops-token" rows={7} autoFocus placeholder={'{"title":"合规新标题"}'} />
            </Form.Item>
            <Form.Item name="reason" label="修改原因" rules={[{ required: true, whitespace: true, message: "请填写创建修正版的原因" }, { min: 4, message: "修改原因至少填写 4 个字符" }]}>
              <Input.TextArea rows={3} placeholder="说明平台驳回原因、修改依据和预期结果" />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
      <Modal title="分配队列负责人" open={Boolean(assignmentTarget)} okText="保存负责人" cancelText="取消" confirmLoading={assignmentSubmitting} onCancel={closeAssignment} onOk={() => assignmentForm.submit()}>
        <Typography.Paragraph>分配结果会写入运营审计，并在刷新后的队列中显示。</Typography.Paragraph>
        <Form form={assignmentForm} layout="vertical" requiredMark onFinish={(values) => void submitAssignment(values)}>
          <Form.Item name="operatorId" label="负责人 ID" rules={[{ required: true, whitespace: true, message: "请输入负责人 ID" }]}>
            <Input autoFocus maxLength={160} placeholder="例如 ops-user-123" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={batchDecision?.action === "pause" ? "暂停批量发布" : batchDecision?.action === "resume" ? "恢复批量发布" : "重试批量发布失败项"}
        open={Boolean(batchDecision)}
        okText={batchDecision?.action === "pause" ? "确认暂停" : batchDecision?.action === "resume" ? "确认恢复" : "校验并重试失败项"}
        cancelText="取消"
        confirmLoading={batchSubmitting}
        okButtonProps={{
          danger: batchDecision?.action === "pause",
          disabled: batchSubmitting || (batchDecision?.action === "pause" && batchReason.trim().length < 4) || (batchDecision?.action === "retry" && !batchConfirmations.trim()),
        }}
        cancelButtonProps={{ disabled: batchSubmitting }}
        closable={!batchSubmitting}
        keyboard={!batchSubmitting}
        mask={{ closable: !batchSubmitting }}
        onCancel={closeBatchDecision}
        onOk={() => void submitBatchDecision()}
        destroyOnHidden
      >
        <Typography.Paragraph>
          批次 <Typography.Text code>{batchDecision?.batch.id}</Typography.Text> · {batchDecision?.batch.itemCount ?? 0} 个商品 · 失败 {batchDecision?.batch.failedCount ?? 0} 项
        </Typography.Paragraph>
        {batchDecision?.action === "pause" && (
          <Alert type="warning" showIcon title="暂停不会撤销已进入平台队列的项目" description="系统只阻止后续确认和失败项重试；已经排队或已受理的项目仍会继续观测回执。" />
        )}
        {batchDecision?.action === "resume" && (
          <Alert type="info" showIcon title="恢复不会自动重试失败项" description="恢复后仅解除批次暂停；失败项仍须提供新的内容版本、快照哈希、确认哈希与幂等键。" />
        )}
        {batchError && <Alert style={{ marginTop: 16 }} type="error" showIcon title="批次操作失败" description={batchError} role="alert" />}
        {batchDecision?.action === "pause" && (
          <Form layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item label="暂停原因" required extra="至少 4 个字符；原因会随批次状态写入审计。">
              <Input.TextArea autoFocus rows={3} maxLength={500} showCount value={batchReason} disabled={batchSubmitting} aria-label="批量发布暂停原因" onChange={(event) => setBatchReason(event.target.value)} />
            </Form.Item>
          </Form>
        )}
        {batchDecision?.action === "retry" && (
          <Form layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item label="失败项的新确认 JSON" required extra="仅允许 1–50 个失败项；每项必须包含 task_id、content_version_id、confirmation_hash、remote_snapshot_hash、idempotency_key。">
              <Input.TextArea autoFocus className="ops-token" rows={9} value={batchConfirmations} disabled={batchSubmitting} aria-label="批量发布失败项新确认 JSON" placeholder={'[{"task_id":"task-1","content_version_id":"content-v2","confirmation_hash":"...","remote_snapshot_hash":"...","idempotency_key":"new-key"}]'} onChange={(event) => setBatchConfirmations(event.target.value)} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </>
  );
}
