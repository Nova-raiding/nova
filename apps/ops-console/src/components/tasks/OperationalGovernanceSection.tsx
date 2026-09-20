import { Alert, Card, Tabs } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { DeliveryGovernancePanel } from "./knowledge/DeliveryGovernancePanel";
import { ImageAuditPanel } from "./knowledge/ImageAuditPanel";
import { MarketingQueuePanel } from "./knowledge/MarketingQueuePanel";
import { UploadedAssetGovernance } from "./knowledge/UploadedAssetGovernance";

export function marketingQueueCount(queue: OpsConsoleModel["marketingQueue"]): number {
  return queue.generation.length
    + queue.publish.length
    + queue.visuals.length
    + queue.batches.length
    + queue.uploadedAssetRisks.length;
}

/**
 * The tasks tab label for the marketing queue.
 *
 * The queue starts as empty arrays and is only replaced by a read that landed,
 * so `0` used to mean three different things at once — a failed read, a read
 * that never happened, and a queue that really is empty. The page-level error
 * banner does not reach this badge, so it has to state the read itself:
 * `queueCount` is `undefined` until a queue read lands.
 */
export function marketingQueueTabLabel(queueCount: number | undefined, error?: string): string {
  if (error) return "任务队列（读取失败）";
  return queueCount === undefined ? "任务队列（未读取）" : `任务队列（${queueCount}）`;
}

export function OperationalGovernanceSection({ model }: { model: OpsConsoleModel }) {
  const queueCount = model.marketingQueueLoadedAt
    ? marketingQueueCount(model.marketingQueue)
    : undefined;
  return (
    <Card title="任务与素材治理" style={{ marginTop: 16 }}>
      <Tabs items={[
        {
          key: "queue",
          label: marketingQueueTabLabel(queueCount, model.dataSetError("ops.marketing.queue")),
          children: <MarketingQueuePanel model={model} />,
        },
        { key: "delivery", label: "交付证据", children: <DeliveryGovernancePanel model={model} /> },
      ]} />
      <ImageAuditPanel />
      <UploadedAssetGovernance model={model} />
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 16 }}
        title="素材治理属于任务流程"
        description="上传素材的扫描、解析、权益补录和重新排队不会写入知识库；只有经过确认的品牌/客户知识才会进入知识库。"
      />
    </Card>
  );
}
