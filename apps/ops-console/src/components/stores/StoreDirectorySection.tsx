import { Button, Card, Input, Modal, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import type { Platform, StoreDirectory } from "../../types/ops";

interface StoreDirectorySectionProps {
  storeDirectory: StoreDirectory[];
  canPlatformOps: boolean;
  onSaveAlias: (store: StoreDirectory, alias: string) => Promise<boolean>;
  onRevoke: (store: StoreDirectory) => Promise<void>;
}

export function StoreDirectorySection({
  storeDirectory,
  canPlatformOps,
  onSaveAlias,
  onRevoke,
}: StoreDirectorySectionProps) {
  const [aliasTarget, setAliasTarget] = useState<StoreDirectory>();
  const [alias, setAlias] = useState("");
  const [savingAlias, setSavingAlias] = useState(false);
  const closeAlias = () => { if (!savingAlias) { setAliasTarget(undefined); setAlias(""); } };
  const submitAlias = async () => {
    if (!aliasTarget || alias.trim().length < 1) return;
    setSavingAlias(true);
    const saved = await onSaveAlias(aliasTarget, alias);
    setSavingAlias(false);
    if (saved) closeAlias();
  };
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
                    : row.dataMode === "fixture"
                      ? "gold"
                    : row.state === "connected"
                      ? "green"
                      : "orange"
                }
              >
                {row.authorization?.reauthorizationRequired
                  ? "需重新授权"
                  : row.dataMode === "fixture"
                    ? "演示授权"
                    : row.state === "connected"
                      ? "真实授权"
                  : row.state}
              </Tag>
            ),
          },
          {
            title: "数据模式",
            dataIndex: "dataMode",
            render: (value: string) => (
              <Tag color={value === "official_api" ? "green" : "gold"}>
                {value === "official_api"
                  ? "官方 API"
                  : value === "fixture"
                    ? "fixture 演示"
                    : value === "account_record_only"
                      ? "仅账号记录"
                      : value}
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
                  onClick={() => { setAliasTarget(row); setAlias(row.alias ?? row.label); }}
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
      <Modal title="修改店铺展示别名" open={Boolean(aliasTarget)} okText="保存别名" cancelText="取消" confirmLoading={savingAlias} okButtonProps={{ disabled: alias.trim().length < 1 }} onCancel={closeAlias} onOk={() => void submitAlias()}>
        <Typography.Paragraph>仅修改运营后台展示名称，不会修改平台店铺真实名称。</Typography.Paragraph>
        <label htmlFor="store-display-alias">店铺展示别名</label>
        <Input id="store-display-alias" autoFocus maxLength={120} showCount value={alias} onChange={(event) => setAlias(event.target.value)} />
      </Modal>
    </Card>
  );
}
