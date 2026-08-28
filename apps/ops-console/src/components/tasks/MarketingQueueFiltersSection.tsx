import { Button, Card, Input, Select, Space } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { platformLabels, platforms } from "../../types/ops";

interface MarketingQueueFiltersSectionProps {
  model: OpsConsoleModel;
}

export function MarketingQueueFiltersSection({
  model,
}: MarketingQueueFiltersSectionProps) {
  const { load, queueFilters, setQueueFilters, storeDirectory } = model;

  return (
    <Card
      id="ops-domain-governance"
      className="ops-section-anchor"
      title="营销队列筛选"
      size="small"
    >
      <Space wrap>
        <Select
          allowClear
          placeholder="平台"
          style={{ width: 150 }}
          value={queueFilters.platform}
          onChange={(value) =>
            setQueueFilters((current) => ({ ...current, platform: value }))
          }
          options={platforms.map((platform) => ({
            value: platform,
            label: platformLabels[platform],
          }))}
        />
        <Select
          allowClear
          placeholder="店铺"
          style={{ width: 240 }}
          value={queueFilters.accountId}
          onChange={(value) =>
            setQueueFilters((current) => ({ ...current, accountId: value }))
          }
          options={storeDirectory.map((store) => ({
            value: store.accountId,
            label: `${store.label} · ${platformLabels[store.platform]}`,
          }))}
        />
        <Input
          allowClear
          placeholder="商品 ID"
          style={{ width: 180 }}
          value={queueFilters.productId ?? ""}
          onChange={(event) =>
            setQueueFilters((current) => ({
              ...current,
              productId: event.target.value || undefined,
            }))
          }
        />
        <Input
          allowClear
          placeholder="任务 ID"
          style={{ width: 180 }}
          value={queueFilters.taskId ?? ""}
          onChange={(event) =>
            setQueueFilters((current) => ({
              ...current,
              taskId: event.target.value || undefined,
            }))
          }
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 160 }}
          value={queueFilters.state}
          onChange={(value) =>
            setQueueFilters((current) => ({ ...current, state: value }))
          }
          options={[
            "queued",
            "running",
            "failed",
            "rejected",
            "unknown",
            "manual_attention",
            "visual_review",
          ].map((state) => ({ value: state, label: state }))}
        />
        <Button type="primary" onClick={() => void load()}>
          应用筛选
        </Button>
        <Button
          onClick={() => {
            setQueueFilters({});
            window.setTimeout(() => void load(), 0);
          }}
        >
          清除筛选
        </Button>
      </Space>
    </Card>
  );
}
