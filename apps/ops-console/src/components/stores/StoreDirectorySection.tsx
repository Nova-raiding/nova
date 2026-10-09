import { Alert, Button, Card, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { platformLabels, platforms, type Platform, type StoreDirectory, type WorkspaceSummary } from "../../types/ops";
import { confirmPolicyPropsFor } from "../../utils/destructiveConfirm.js";

interface StoreDirectorySectionProps {
  storeDirectory: StoreDirectory[];
  canPlatformOps: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSaveAlias: (store: StoreDirectory, alias: string) => Promise<boolean>;
  onRevoke: (store: StoreDirectory) => Promise<void>;
  workspaces?: WorkspaceSummary[];
  onRegisterManualStore?: (input: { workspaceId: string; platform: Platform; accountId: string; storeAlias?: string; reason: string }) => Promise<boolean>;
}

// Every value `platform_accounts.token_state` can hold needs an honest label here.
// Missing keys used to fall through to 状态待确认, which made a KNOWN state look like a
// broken one: `manually_registered` (written by ops.platform.store.record.create, the
// credential-free manual registration path) and `refresh_required` both collapsed into
// "unknown". `manually_registered` must never read as 真实授权 — that label belongs to
// `connected`, and the manual record carries no credential, scope or platform receipt.
export function storeAuthorizationStateLabel(state: string): string {
  return ({
    connected: "真实授权",
    refresh_required: "需重新授权",
    revoked: "已撤销",
    manually_registered: "人工登记（未授权）",
    pending: "待授权",
    unknown: "状态待确认",
  } as Record<string, string>)[state] ?? "状态待确认";
}

export function StoreDirectorySection({
  storeDirectory,
  canPlatformOps,
  loading = false,
  error,
  onRetry,
  onSaveAlias,
  onRevoke,
  workspaces = [],
  onRegisterManualStore,
}: StoreDirectorySectionProps) {
  const [aliasTarget, setAliasTarget] = useState<StoreDirectory>();
  const [alias, setAlias] = useState("");
  const [savingAlias, setSavingAlias] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string>();
  const [revokeTarget, setRevokeTarget] = useState<StoreDirectory>();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [manualWorkspaceId, setManualWorkspaceId] = useState("");
  const [manualPlatform, setManualPlatform] = useState<Platform>();
  const [manualAccountId, setManualAccountId] = useState("");
  const [manualAlias, setManualAlias] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [manualStoreError, setManualStoreError] = useState("");
  const [manualStoreBoundaryApplicable, setManualStoreBoundaryApplicable] = useState<boolean>();
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
  const representedStoreCount = storeDirectory.reduce((total, store) => total + (store.aggregate === true && Number.isSafeInteger(store.count) && (store.count ?? 0) >= 0 ? store.count! : 1), 0);
  const resetManualForm = () => {
    setRegisterOpen(false); setManualWorkspaceId(""); setManualPlatform(undefined);
    setManualAccountId(""); setManualAlias(""); setManualReason("");
    setManualStoreError("");
  };
  const submitManualStore = async () => {
    if (!onRegisterManualStore || !manualWorkspaceId || !manualPlatform || !manualAccountId.trim() || !manualReason.trim()) return;
    setRegistering(true);
    setManualStoreError("");
    try {
      const appliesToStoreBoundary = await onRegisterManualStore({ workspaceId: manualWorkspaceId, platform: manualPlatform, accountId: manualAccountId.trim(), ...(manualAlias.trim() ? { storeAlias: manualAlias.trim() } : {}), reason: manualReason.trim() });
      resetManualForm();
      setManualStoreBoundaryApplicable(appliesToStoreBoundary);
    } catch (error) {
      setManualStoreError(error instanceof Error && error.message.trim() ? error.message : "人工店铺登记失败，请检查输入和权限后重试。");
    } finally { setRegistering(false); }
  };

  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  return (
    <Card
      id="ops-domain-stores"
      className="ops-section-anchor"
      title="平台连接与授权健康"
      extra={
        <Space>
          {canPlatformOps && onRegisterManualStore ? <Button type="primary" onClick={() => { setManualStoreError(""); setManualStoreBoundaryApplicable(undefined); setRegisterOpen(true); }}>登记人工店铺</Button> : null}
          <Tag color={representedStoreCount ? "blue" : "orange"}>{loading || error ? "状态待确认" : `${representedStoreCount} 个已登记店铺`}</Tag>
        </Space>
      }
    >
      <Table
        rowKey={(row: StoreDirectory) => row.aggregate === true
          ? `summary:${row.platform}:${row.state}:${row.dataMode}:${Number(row.readable)}:${Number(row.writeEnabled)}`
          : `${row.platform}:${row.accountId}`}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => storeDirectory.some((store) => store.aggregate === true) ? `共 ${total} 个平台汇总组` : `共 ${total} 条` }}
        loading={loading}
        dataSource={storeDirectory}
        locale={{
          emptyText: loading ? "正在读取店铺目录…" : initialLoadFailed ? "尚未取得店铺目录；请先检查网络或工作区权限。" : (
            <Space orientation="vertical" size={4}>
              <Typography.Text>暂无已登记店铺</Typography.Text>
              <Typography.Text type="secondary">尚未连接店铺不代表没有工作区权限，可先在已授权工作区导入商品资料、预览草稿。</Typography.Text>
              <Typography.Text type="secondary">真实平台同步和发布仍需连接对应店铺，并具备相应操作权限。</Typography.Text>
            </Space>
          ),
        }}
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
                {row.aggregate !== true && <Typography.Text type="secondary">{row.accountId}</Typography.Text>}
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
                  : storeAuthorizationStateLabel(row.state)}
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
              ? "当前空列表不代表没有已登记店铺；请检查网络或工作区权限后重新加载。"
              : "已保留上一次成功读取的店铺目录；请检查网络或工作区权限后重新加载。"}
            action={onRetry ? <Button htmlType="button" style={{ minHeight: 44 }} aria-label="刷新店铺目录" onClick={onRetry}>刷新店铺目录</Button> : undefined}
          />
        </div>
      ) : null}
      <Typography.Text type="secondary">
        此处仅展示平台连接元数据，不读取客户商品、素材或营销内容；别名只用于展示，撤销或重新授权都会留下审计记录。
      </Typography.Text>
      {manualStoreBoundaryApplicable !== undefined ? (
        <Alert
          role="status"
          style={{ marginTop: 16 }}
          type={manualStoreBoundaryApplicable ? "success" : "warning"}
          showIcon
          title="人工店铺已登记"
          description={manualStoreBoundaryApplicable
            ? "该记录适用于当前人工运营边界。它不包含平台凭证，也不代表已获得平台授权。"
            : "当前部署的人工运营边界策略未启用。该记录已保存为账号记录，但不会因此获得人工运营边界、平台授权或同步权限。"}
        />
      ) : null}
      <Modal title="登记人工店铺" open={registerOpen} okText="确认登记" cancelText="取消" confirmLoading={registering}
        okButtonProps={{ disabled: !manualWorkspaceId || !manualPlatform || !manualAccountId.trim() || !manualReason.trim() }}
        onCancel={() => { if (!registering) resetManualForm(); }} onOk={() => void submitManualStore()}>
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {manualStoreError ? <Alert role="alert" type="error" showIcon title="人工店铺登记失败" description={manualStoreError} /> : null}
          <label htmlFor="manual-store-workspace">商家工作区</label>
          <Select id="manual-store-workspace" value={manualWorkspaceId || undefined} onChange={setManualWorkspaceId} options={workspaces.filter(item => item.status === "active").map(item => ({ value: item.workspaceId, label: `${item.enterpriseName ?? "未命名企业主体"} · ${item.workspaceId}` }))} placeholder="选择已启用商家工作区" showSearch optionFilterProp="label" />
          <label htmlFor="manual-store-platform">平台</label>
          <Select id="manual-store-platform" value={manualPlatform} onChange={setManualPlatform} options={platforms.map(platform => ({ value: platform, label: platformLabels[platform] }))} placeholder="选择平台" />
          <label htmlFor="manual-store-account">平台店铺账号 ID</label>
          <Input id="manual-store-account" value={manualAccountId} onChange={event => setManualAccountId(event.target.value)} maxLength={256} />
          <label htmlFor="manual-store-alias">店铺别名（可选）</label>
          <Input id="manual-store-alias" aria-describedby="manual-store-alias-limit" value={manualAlias} onChange={event => setManualAlias(event.target.value)} maxLength={40} showCount />
          <Typography.Text id="manual-store-alias-limit" type="secondary">最多 40 个可见字符，与平台店铺别名规则一致。</Typography.Text>
          <label htmlFor="manual-store-reason">登记理由</label>
          <Input.TextArea id="manual-store-reason" value={manualReason} onChange={event => setManualReason(event.target.value)} maxLength={500} showCount />
        </Space>
      </Modal>
      <Modal title="修改店铺展示别名" open={Boolean(aliasTarget)} okText="保存别名" cancelText="取消" confirmLoading={savingAlias} okButtonProps={{ disabled: alias.trim().length < 1 }} onCancel={closeAlias} onOk={() => void submitAlias()}>
        <Typography.Paragraph>仅修改运营后台展示名称，不会修改平台店铺真实名称。</Typography.Paragraph>
        <label htmlFor="store-display-alias">店铺展示别名</label>
        <Input id="store-display-alias" aria-describedby="store-display-alias-limit" autoFocus maxLength={40} showCount value={alias} onChange={(event) => setAlias(event.target.value)} />
        <Typography.Text id="store-display-alias-limit" type="secondary">最多 40 个可见字符，与平台店铺别名规则一致。</Typography.Text>
      </Modal>
      <Modal
        title="确认撤销平台授权？"
        open={Boolean(revokeTarget)}
        okText="确认撤销"
        cancelText="取消"
        {...confirmPolicyPropsFor("store.revoke")}
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
