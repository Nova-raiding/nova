import { Button, Card, Space, Table, Tag, Typography } from "antd";
import type { Platform, StoreDirectory } from "../../types/ops";

interface StoreDirectorySectionProps {
  storeDirectory: StoreDirectory[];
  canPlatformOps: boolean;
  onSaveAlias: (store: StoreDirectory) => Promise<void>;
  onRevoke: (store: StoreDirectory) => Promise<void>;
}

export function StoreDirectorySection({
  storeDirectory,
  canPlatformOps,
  onSaveAlias,
  onRevoke,
}: StoreDirectorySectionProps) {
  return (
    <Card
      id="ops-domain-stores"
      className="ops-section-anchor"
      title="绑定店铺与授权状态"
      extra={
        <Tag color={storeDirectory.length ? "blue" : "orange"}>
          {storeDirectory.length} 个已登记店铺
        </Tag>
      }
    >
      <Table
        rowKey={(row: StoreDirectory) => `${row.platform}:${row.accountId}`}
        pagination={{ pageSize: 8 }}
        dataSource={storeDirectory}
        columns={[
          {
            title: "平台",
            dataIndex: "platform",
            render: (value: Platform) => <Tag>{value.toUpperCase()}</Tag>,
          },
          {
            title: "店铺",
            render: (_: unknown, row: StoreDirectory) => (
              <Space orientation="vertical" size={0}>
                <Typography.Text strong>{row.label}</Typography.Text>
                <Typography.Text type="secondary">
                  {row.accountId}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "授权",
            render: (_: unknown, row: StoreDirectory) => (
              <Tag
                color={
                  row.authorization?.reauthorizationRequired ||
                  row.state === "revoked"
                    ? "red"
                    : row.state === "connected"
                      ? "green"
                      : "orange"
                }
              >
                {row.authorization?.reauthorizationRequired
                  ? "需重新授权"
                  : row.state}
              </Tag>
            ),
          },
          {
            title: "数据模式",
            dataIndex: "dataMode",
            render: (value: string) => (
              <Tag color={value === "official_api" ? "green" : "gold"}>
                {value}
              </Tag>
            ),
          },
          {
            title: "同步",
            render: (_: unknown, row: StoreDirectory) =>
              row.sync?.lastSuccessfulAt
                ? `最近成功：${new Date(row.sync.lastSuccessfulAt).toLocaleString()}`
                : (row.sync?.latestState ?? "暂无记录"),
          },
          {
            title: "读/写",
            render: (_: unknown, row: StoreDirectory) =>
              `${row.readable ? "读" : "—"} / ${row.writeEnabled ? "写" : "—"}`,
          },
          {
            title: "操作",
            render: (_: unknown, row: StoreDirectory) => (
              <Space>
                <Button
                  type="link"
                  disabled={!canPlatformOps || row.state === "revoked"}
                  onClick={() => void onSaveAlias(row)}
                >
                  改别名
                </Button>
                <Button
                  type="link"
                  danger
                  disabled={!canPlatformOps || row.state === "revoked"}
                  onClick={() => void onRevoke(row)}
                >
                  撤销
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Typography.Text type="secondary">
        店铺以 platform + account_id
        隔离；别名只用于展示，撤销或重新授权都会留下审计记录。
      </Typography.Text>
    </Card>
  );
}
