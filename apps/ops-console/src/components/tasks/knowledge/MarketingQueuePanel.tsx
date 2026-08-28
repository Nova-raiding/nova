import type { ReactNode } from "react";
import { Button, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";

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
    retryGeneration,
    reviewVisual,
  } = model;

  const rows: QueueRow[] = [
    ...marketingQueue.batches.map((batch) => ({
      id: `batch:${batch.id}`,
      kind: "批量发布",
      taskId: `${batch.itemCount} 个商品`,
      state: batch.state,
      detail: `已排队 ${batch.queuedCount}，失败 ${batch.failedCount}${batch.pauseReason ? `；暂停：${batch.pauseReason}` : ""}`,
      updatedAt: batch.updatedAt,
      action: null,
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
              void assignQueueItem(
                "generation",
                job.id,
                job.revision,
                job.assignedOperatorId,
              )
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
              void assignQueueItem(
                "publish",
                job.id,
                job.revision,
                job.assignedOperatorId,
              )
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
                <Button type="link" onClick={() => void createRevision(job)}>
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
  );
}
