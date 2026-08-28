import { Card, Select, Space, Tag, Typography } from "antd";
import type { StoreDirectory } from "../../types/ops";

interface SelectedAutomationStore {
  label: string;
  platform: string;
}

interface AutomationScopeSectionProps {
  storeDirectory: StoreDirectory[];
  selectedAutomationStore: SelectedAutomationStore | undefined;
  automationScope: string;
  canQueue: boolean;
  onLoadScope: (scope: string) => Promise<void>;
}

export function AutomationScopeSection({
  storeDirectory,
  selectedAutomationStore,
  automationScope,
  canQueue,
  onLoadScope,
}: AutomationScopeSectionProps) {
  return (
    <Card
      title="自动化运营作用域"
      extra={
        <Tag color={selectedAutomationStore ? "blue" : "gold"}>
          {selectedAutomationStore
            ? `${selectedAutomationStore.label}（${selectedAutomationStore.platform}）`
            : "全工作区"}
        </Tag>
      }
    >
      <Space wrap>
        <Typography.Text>选择店铺：</Typography.Text>
        <Select
          aria-label="自动化店铺作用域"
          disabled={!canQueue}
          value={automationScope}
          onChange={(value) => void onLoadScope(value)}
          style={{ minWidth: 260 }}
          options={[
            { value: "", label: "全工作区" },
            ...storeDirectory.map((row) => ({
              value: `${row.platform}:${row.accountId}`,
              label: `${row.label} · ${row.platform}`,
            })),
          ]}
        />
        <Typography.Text type="secondary">
          策略、扫描、暂停均按所选 platform + account_id
          隔离；未选择时才操作全工作区。
        </Typography.Text>
      </Space>
    </Card>
  );
}
