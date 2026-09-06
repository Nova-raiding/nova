import { Alert, Card, Tabs } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { DeliveryGovernancePanel } from "./knowledge/DeliveryGovernancePanel";
import { ImageAuditPanel } from "./knowledge/ImageAuditPanel";
import { MarketingQueuePanel } from "./knowledge/MarketingQueuePanel";
import { UploadedAssetGovernance } from "./knowledge/UploadedAssetGovernance";

export function OperationalGovernanceSection({ model }: { model: OpsConsoleModel }) {
  const queueCount = model.marketingQueue.generation.length
    + model.marketingQueue.publish.length
    + model.marketingQueue.visuals.length
    + model.marketingQueue.batches.length
    + model.marketingQueue.uploadedAssetRisks.length;
  return (
    <Card title="任务与素材治理" style={{ marginTop: 16 }}>
      <Tabs items={[
        { key: "queue", label: `任务队列（${queueCount}）`, children: <MarketingQueuePanel model={model} /> },
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
