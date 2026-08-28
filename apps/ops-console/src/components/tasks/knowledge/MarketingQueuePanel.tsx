import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Form, Input, Modal, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import { parseRevisionChangesJson, type RevisionCreationValues } from "./revisionCreation.js";

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

function stateColor(state: string) {
  if (
    ["failed", "rejected", "unknown", "manual_attention", "blocked"].includes(
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

export function MarketingQueuePanel({ model }: MarketingQueuePanelProps) {
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
  } = model;
  const [revisionForm] = Form.useForm<RevisionCreationValues>();
  const [revisionTarget, setRevisionTarget] = useState<OpsConsoleModel["marketingQueue"]["publish"][number]>();
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState("");
  const [assignmentForm] = Form.useForm<{ operatorId: string }>();
  const [assignmentTarget, setAssignmentTarget] = useState<{ itemType: "generation" | "publish"; itemId: string; revision: number; currentOperator?: string | null }>();
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
  const revisionErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (revisionError) revisionErrorRef.current?.focus();
  }, [revisionError]);

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
  const openAssignment = (target: { itemType: "generation" | "publish"; itemId: string; revision: number; currentOperator?: string | null }) => {
    assignmentForm.setFieldsValue({ operatorId: target.currentOperator ?? "" });
    setAssignmentTarget(target);
  };
  const closeAssignment = () => { if (!assignmentSubmitting) { setAssignmentTarget(undefined); assignmentForm.resetFields(); } };
  const submitAssignment = async (values: { operatorId: string }) => {
    if (!assignmentTarget) return;
    setAssignmentSubmitting(true);
    const saved = await assignQueueItem(assignmentTarget.itemType, assignmentTarget.itemId, assignmentTarget.revision, values.operatorId);
    setAssignmentSubmitting(false);
    if (saved) closeAssignment();
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
        <Space>
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
      state: visual.reviewStatus,
      detail: `SKU：${visual.skuIds.join(", ") || "全 SKU"}；候选 ${visual.ordinal}；${visual.assignedOperatorId ? `负责人：${visual.assignedOperatorId}` : "未分配负责人"}`,
      updatedAt: visual.updatedAt,
      action: (
        <Space>
          <Button
            type="link"
            onClick={() => void reviewVisual(visual, "passed")}
          >
            通过
          </Button>
          <Button
            type="link"
            danger
            onClick={() => void reviewVisual(visual, "blocked")}
          >
            阻断
          </Button>
        </Space>
      ),
    })),
    ...marketingQueue.uploadedAssetRisks.map((asset) => ({
      id: `uploaded-asset:${asset.id}`,
      kind: "上传素材",
      taskId: asset.name,
      state: asset.readiness.status,
      detail: `${asset.readiness.reasons.join("；") || "待处理"}；下一步：${asset.nextAction?.label ?? asset.nextStep ?? "联系安全审核"}`,
      updatedAt: asset.createdAt,
      action: <Typography.Text type="secondary">商家交互确认</Typography.Text>,
    })),
  ];

  return (
    <>
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
            <Tag color={stateColor(value)}>{value}</Tag>
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
        title="创建发布修正版"
        open={Boolean(revisionTarget)}
        okText="创建并进入审核"
        cancelText="取消"
        confirmLoading={revisionSubmitting}
        onCancel={closeRevisionModal}
        onOk={() => revisionForm.submit()}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
