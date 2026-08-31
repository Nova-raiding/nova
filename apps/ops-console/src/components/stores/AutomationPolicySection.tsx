import { Alert, Button, Card, Table, Tag } from "antd";
import type { AutomationPolicy } from "../../types/ops";

interface AutomationPolicySectionProps {
  automationPolicies: AutomationPolicy[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

export function AutomationPolicySection({
  automationPolicies,
  loading = false,
  error,
  onRetry,
}: AutomationPolicySectionProps) {
  return (
    <Card
      title="已配置的店铺自动化策略"
      extra={
        <Tag color={automationPolicies.length ? "blue" : "default"}>
          {loading || error ? "状态待确认" : `${automationPolicies.length} 条`}
        </Tag>
      }
    >
      {error ? (
        <Alert role="alert" type="error" showIcon title="自动化策略读取失败" description={error} action={onRetry ? <Button style={{ minHeight: 44 }} onClick={onRetry}>重试</Button> : undefined} />
      ) : (
      <Table
        rowKey={(row) =>
          row.id ??
          `${row.platform ?? "workspace"}:${row.accountId ?? "default"}`
        }
        pagination={{ pageSize: 6 }}
        loading={loading}
        dataSource={loading ? [] : automationPolicies}
        locale={{ emptyText: loading ? "正在读取自动化策略…" : "暂无自动化策略；当前不会执行定时扫描或自动重试。" }}
        columns={[
          {
            title: "店铺",
            render: (_: unknown, row: AutomationPolicy) =>
              row.aggregate ? `${row.count ?? 0} 个店铺（平台聚合）` : row.store?.label ??
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
      )}
    </Card>
  );
}
