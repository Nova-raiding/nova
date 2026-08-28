import { Card, Table, Tag } from "antd";
import type { AutomationPolicy } from "../../types/ops";

interface AutomationPolicySectionProps {
  automationPolicies: AutomationPolicy[];
}

export function AutomationPolicySection({
  automationPolicies,
}: AutomationPolicySectionProps) {
  return (
    <Card
      title="已配置的店铺自动化策略"
      extra={
        <Tag color={automationPolicies.length ? "blue" : "default"}>
          {automationPolicies.length} 条
        </Tag>
      }
    >
      <Table
        rowKey={(row) =>
          row.id ??
          `${row.platform ?? "workspace"}:${row.accountId ?? "default"}`
        }
        pagination={{ pageSize: 6 }}
        dataSource={automationPolicies}
        columns={[
          {
            title: "店铺",
            render: (_: unknown, row: AutomationPolicy) =>
              row.store?.label ??
              (row.platform
                ? `${row.platform} / ${row.accountId ?? "未绑定"}`
                : "全工作区"),
          },
          {
            title: "状态",
            dataIndex: "enabled",
            render: (value: boolean) => (
              <Tag color={value ? "green" : "orange"}>
                {value ? "运行中" : "已暂停"}
              </Tag>
            ),
          },
          { title: "模式", dataIndex: "mode" },
          {
            title: "频率",
            render: (_: unknown, row: AutomationPolicy) =>
              `${row.frequencyMinutes} 分钟`,
          },
          {
            title: "下次执行",
            dataIndex: "nextRunAt",
            render: (value?: string) =>
              value ? new Date(value).toLocaleString() : "-",
          },
          {
            title: "暂停原因",
            dataIndex: "pauseReason",
            render: (value?: string) => value || "-",
          },
        ]}
      />
    </Card>
  );
}
