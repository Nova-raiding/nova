import { Button, Card, Space, Switch, Tag, Typography } from "antd";
import type { AutomationPolicy } from "../../types/ops";

interface AutoSyncSectionProps {
  automationPolicy: AutomationPolicy | undefined;
  selectedAutomationStore: unknown;
  canQueue: boolean;
  onUpdateSync: (enabled: boolean) => void;
  onUpdate: (enabled: boolean, reason?: string) => Promise<void>;
}

export function AutoSyncSection({
  automationPolicy,
  selectedAutomationStore,
  canQueue,
  onUpdateSync,
  onUpdate,
}: AutoSyncSectionProps) {
  return (
    <Card
      title="自动商品同步"
      extra={
        <Tag color={automationPolicy?.syncEnabled ? "blue" : "default"}>
          {automationPolicy?.syncEnabled ? "已启用" : "未启用"}
        </Tag>
      }
    >
      <Space>
        <Typography.Text>仅允许对已选定的单个店铺开启：</Typography.Text>
        <Switch
          aria-label="自动商品同步"
          disabled={!canQueue || !selectedAutomationStore}
          checked={automationPolicy?.syncEnabled ?? false}
          onChange={onUpdateSync}
        />
        <Button
          size="small"
          type="primary"
          disabled={!canQueue || !automationPolicy || !selectedAutomationStore}
          onClick={() =>
            void onUpdate(
              automationPolicy?.enabled ?? false,
              "运营台保存店铺自动同步策略",
            )
          }
        >
          保存同步策略
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">
        自动化 Worker
        只创建商品同步任务并写入风险告警，不会自动发布、自动重发或绕过人工确认。请先在上方选择具体店铺。
      </Typography.Paragraph>
    </Card>
  );
}
