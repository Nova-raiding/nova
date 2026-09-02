import { Alert, Button, Card, Input, Modal, Space, Table, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { Platform, StoreDirectory } from "../../types/ops";

interface StoreDirectorySectionProps {
  storeDirectory: StoreDirectory[];
  canPlatformOps: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSaveAlias: (store: StoreDirectory, alias: string) => Promise<boolean>;
  onRevoke: (store: StoreDirectory) => Promise<void>;
}

export function StoreDirectorySection({
  storeDirectory,
  canPlatformOps,
  loading = false,
  error,
  onRetry,
  onSaveAlias,
  onRevoke,
}: StoreDirectorySectionProps) {
  const [aliasTarget, setAliasTarget] = useState<StoreDirectory>();
  const [alias, setAlias] = useState("");
  const [savingAlias, setSavingAlias] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string>();
  const [revokeTarget, setRevokeTarget] = useState<StoreDirectory>();
  const errorRef = useRef<HTMLDivElement>(null);
  const closeAlias = () => { if (!savingAlias) { setAliasTarget(undefined); setAlias(""); } };
  const submitAlias = async () => {
    if (!aliasTarget || alias.trim().length < 1) return;
    setSavingAlias(true);
    try {
      const saved = await onSaveAlias(aliasTarget, alias);
      if (saved) { setAliasTarget(undefined); setAlias(""); }
    } finally {
      setSavingAlias(false);
    }
  };
  const revoke = async (store: StoreDirectory) => {
    const key = `${store.platform}:${store.accountId}`;
    setRevokingKey(key);
    try { await onRevoke(store); } finally { setRevokingKey(undefined); }
  };
  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    await revoke(revokeTarget);
    setRevokeTarget(undefined);
  };
  const initialLoadFailed = Boolean(error && storeDirectory.length === 0 && !loading);

  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  return (
    <Card
      id="ops-domain-stores"
      className="ops-section-anchor"
      title="平台连接与授权健康"
      extra={
        <Tag color={storeDirectory.length ? "blue" : "orange"}>
          {loading || error ? "状态待确认" : `${storeDirectory.length} 个已登记店铺`}
        </Tag>
      }
    >
      <Table
        rowKey={(row: StoreDirectory) => `${row.platform}:${row.accountId}`}
        pagination={{ pageSize: 8 }}
        loading={loading}
        dataSource={storeDirectory}
        locale={{ emptyText: loading ? "正在读取店铺目录…" : initialLoadFailed ? "尚未取得店铺目录；请先恢复连接或权限。" : "暂无已登记店铺；完成平台授权后会显示在这里。" }}
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
                  style={{ minHeight: 44 }}
                  disabled={!canPlatformOps || row.aggregate === true || row.state === "revoked"}
                  onClick={() => { setAliasTarget(row); setAlias(row.alias ?? row.label); }}
                >
                  改别名
                </Button>
                <Button
                  type="link"
                  danger
                  style={{ minHeight: 44 }}
                  loading={revokingKey === `${row.platform}:${row.accountId}`}
                  disabled={!canPlatformOps || row.aggregate === true || row.state === "revoked" || Boolean(revokingKey)}
                  onClick={() => setRevokeTarget(row)}
                >
                  撤销
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {error ? (
        <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-atomic="true" aria-labelledby="store-directory-error-title" style={{ marginTop: 16 }}>
          <Alert
            type="error"
            showIcon
            title={<span id="store-directory-error-title">店铺目录读取失败</span>}
            description={initialLoadFailed
              ? "当前空列表不代表没有已登记店铺；请修复连接或权限后重新加载。"
              : "已保留上一次成功读取的店铺目录；请修复连接或权限后重新加载。"}
            action={onRetry ? <Button htmlType="button" style={{ minHeight: 44 }} aria-label="刷新店铺目录" onClick={onRetry}>刷新店铺目录</Button> : undefined}
          />
        </div>
      ) : null}
      <Typography.Text type="secondary">
        此处仅展示平台连接元数据，不读取客户商品、素材或营销内容；别名只用于展示，撤销或重新授权都会留下审计记录。
      </Typography.Text>
      <Modal title="修改店铺展示别名" open={Boolean(aliasTarget)} okText="保存别名" cancelText="取消" confirmLoading={savingAlias} okButtonProps={{ disabled: alias.trim().length < 1 }} onCancel={closeAlias} onOk={() => void submitAlias()}>
        <Typography.Paragraph>仅修改运营后台展示名称，不会修改平台店铺真实名称。</Typography.Paragraph>
        <label htmlFor="store-display-alias">店铺展示别名</label>
        <Input id="store-display-alias" autoFocus maxLength={120} showCount value={alias} onChange={(event) => setAlias(event.target.value)} />
      </Modal>
      <Modal
        title="确认撤销平台授权？"
        open={Boolean(revokeTarget)}
        okText="确认撤销"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={Boolean(revokingKey)}
        onCancel={() => { if (!revokingKey) setRevokeTarget(undefined); }}
        onOk={() => void confirmRevoke()}
      >
        <Typography.Paragraph>
          将撤销 {revokeTarget?.label ?? "该店铺"} 的平台授权，后续同步和发布会停止；如需继续使用，必须重新授权。该操作会写入审计记录。
        </Typography.Paragraph>
      </Modal>
    </Card>
  );
}
