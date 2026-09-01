import { useMemo, useState } from "react";
import { Alert, Button, Card, Col, Descriptions, Drawer, Empty, Row, Segmented, Space, Statistic, Table, Tag, Typography } from "antd";
import { CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import type { CanonicalProductConsistencyReport } from "../../types/ops.js";

type Status = "verified" | "legacy_only" | "conflict" | "blocked";
type PresentationReport = Omit<CanonicalProductConsistencyReport, "freshness"> & {
  generatedAt?: string | null;
  readMode?: "live" | "snapshot";
  freshness?: "fresh" | "stale" | "expired" | "unknown";
  contractStatus?: "clean" | "attention_required" | "unknown" | "unavailable";
  availability?: "available" | "unknown" | "unavailable";
  error?: { code?: string; message?: string } | null;
};
const statusMeta: Record<Status, { label: string; color: string }> = {
  verified: { label: "已验证", color: "success" },
  legacy_only: { label: "仅旧商品", color: "warning" },
  conflict: { label: "存在冲突", color: "error" },
  blocked: { label: "已阻断", color: "warning" },
};
const codeMessage = (code: string) => ({
  CANONICAL_MAPPING_MISSING: "未找到规范商品映射",
  CANONICAL_MAPPING_AMBIGUOUS: "存在多个规范商品映射，无法自动判断",
  LISTING_MAPPING_MISSING: "当前平台店铺缺少 listing 映射",
  ASSET_SCAN_NOT_CLEAN: "关联素材尚未通过安全扫描",
  ASSET_RIGHTS_NOT_APPROVED: "关联素材权益尚未批准",
}[code] ?? code);
const nextActionCopy = (finding: CanonicalProductConsistencyReport["findings"][number]) => {
  const action = finding.nextAction;
  if (!action) return finding.status === "verified" ? "无需修复；继续动作仍需通过发布门禁" : "服务端未提供可执行动作，当前保持只读阻断";
  if (!action.permission.allowed) return `${action.label}（需要 ${action.permission.requiredRole ?? "指定角色"} 权限）`;
  return `服务端动作：${action.label}`;
};
function NextActionEvidence({
  finding,
  onExecute,
}: {
  finding: CanonicalProductConsistencyReport["findings"][number];
  onExecute?: (finding: CanonicalProductConsistencyReport["findings"][number]) => void;
}) {
  const action = finding.nextAction;
  if (!action) return <Typography.Text type={finding.status === "verified" ? "secondary" : "warning"}>{nextActionCopy(finding)}</Typography.Text>;
  const executable = action.permission.allowed && Boolean(onExecute);
  return <Space orientation="vertical" size={2}>
    <Typography.Text type={finding.status === "verified" ? "secondary" : "warning"}>{nextActionCopy(finding)}</Typography.Text>
    <Typography.Text type="secondary" aria-label="服务端动作证据">
      {action.method} · {action.reason}
      {action.requiredInputs.length > 0 ? ` · 输入：${action.requiredInputs.join("、")}` : " · 无额外输入"}
      {action.confirmation === "interactive_confirmation" ? " · 需要交互确认" : " · 无需交互确认"}
    </Typography.Text>
    {action.permission.allowed && <Button
      className="canonical-consistency-action"
      size="small"
      type="link"
      disabled={!executable}
      aria-disabled={!executable}
      aria-label={executable ? `执行：${action.label}` : `服务端动作 ${action.label} 尚未接入`}
      onClick={() => { if (executable) onExecute?.(finding); }}
    >{executable ? action.label : `${action.label}（待接入）`}</Button>}
  </Space>;
}
const freshnessMeta = {
  fresh: { label: "报告新鲜", color: "success" },
  stale: { label: "报告已变旧", color: "warning" },
  expired: { label: "报告已过期", color: "error" },
  unknown: { label: "新鲜度未知", color: "default" },
} as const;
const orphanEntityMeta = {
  canonical_product: "规范商品",
  listing: "Listing",
  campaign_item: "批次商品",
  task: "任务",
  publish_job: "发布任务",
} as const;

export function CanonicalProductConsistencySection({ report, onRefresh, onNextAction, loading = false, canRead = true }: { report?: PresentationReport; onRefresh?: () => void; onNextAction?: (finding: CanonicalProductConsistencyReport["findings"][number]) => void; loading?: boolean; canRead?: boolean }) {
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [selected, setSelected] = useState<CanonicalProductConsistencyReport["findings"][number]>();
  const [selectedOrphan, setSelectedOrphan] = useState<CanonicalProductConsistencyReport["orphanFindings"][number]>();
  const findings = useMemo(() => report?.findings.filter(row => filter === "all" || row.status === filter) ?? [], [filter, report]);
  const orphanFindings = useMemo(() => report?.orphanFindings.filter(row => filter === "all" || row.status === filter) ?? [], [filter, report]);
  if (!canRead) return <Card className="canonical-consistency-card" title="规范商品一致性"><Alert type="info" showIcon title="当前会话无权读取一致性证据" description="这不是空结果；当前账号缺少 customer.content.read，服务端不会返回商品关系数据，也不能通过本页面发起重新检查。" /></Card>;
  if (!report) return <Card className="canonical-consistency-card" title="规范商品一致性" extra={<Button className="canonical-consistency-action" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>重新检查</Button>}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可验证的一致性报告；当前不能视为已通过" /></Card>;
  const expired = report.freshness === "expired";
  const stale = report.freshness === "stale" || report.freshness === "unknown";
  const unavailable = report.availability === "unavailable" || report.contractStatus === "unavailable";
  const uncertain = report.availability === "unknown" || report.contractStatus === "unknown";
  // A stale/unknown report is not evidence that the current chain is clean.
  // Keep the card in an attention state until a fresh server report arrives.
  const hasAttention = loading || report.status !== "clean" || expired || stale || Boolean(report.error);
  const errorCodes = [...new Set(report.findings.flatMap((row) => row.codes))];
  return <>
    <Card className="canonical-consistency-card" title={<Space>规范商品一致性 <Tag color={loading ? "processing" : hasAttention ? "warning" : "success"}>{loading ? "检查中" : hasAttention ? "需处理" : "已验证"}</Tag></Space>} extra={<Button className="canonical-consistency-action" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>重新检查</Button>}>
      <Typography.Paragraph type="secondary">只读检查 canonical → listing → campaign item → task 关系链；未验证状态不会自动修复或允许继续发布。</Typography.Paragraph>
      {loading && <Alert type="info" showIcon role="status" title="正在重新检查" description="旧报告暂不作为当前结论；请等待新的服务端证据返回。" style={{ marginBottom: 12 }} />}
      {report.error && <Alert role="alert" showIcon type="error" icon={<ExclamationCircleOutlined />} title="一致性报告读取失败" description={report.error.message ?? report.error.code ?? "服务端未返回可用报告"} action={<Button className="canonical-consistency-action" size="small" aria-label="重试" onClick={onRefresh} loading={loading}>重试</Button>} style={{ marginBottom: 12 }} />}
      {report.freshness && <Alert showIcon type={report.freshness === "fresh" ? "success" : report.freshness === "expired" ? "error" : "warning"} title={freshnessMeta[report.freshness].label} description={report.freshness === "expired" || report.freshness === "unknown" ? "当前结果不能作为发布依据，请重新检查并等待新的服务端报告。" : report.freshness === "stale" ? "结果可能未覆盖最新关系；处理前请重新检查。" : "结果可作为当前工作区的只读依据。"} style={{ marginBottom: 12 }} />}
      {(unavailable || uncertain) && <Alert role="alert" showIcon type="error" title={unavailable ? "一致性数据暂不可读取" : "一致性数据尚未确认"} description={unavailable ? "这不是零结果；服务端没有返回可验证数据。请重试或联系具备权限的运营人员，当前禁止继续相关发布动作。" : "当前读取结果尚不确定，不能视为已验证。请重新检查后再处理。"} action={<Button className="canonical-consistency-action" size="small" onClick={onRefresh} loading={loading}>重新检查</Button>} style={{ marginBottom: 16 }} />}
      {hasAttention && <Alert showIcon type="warning" icon={<ExclamationCircleOutlined />} title="存在未验证关系" description={<div><div>请打开具体商品查看稳定错误码、影响范围和下一步；不要把数量摘要当作全部一致。</div>{errorCodes.length > 0 && <div id="canonical-consistency-error-summary" className="canonical-error-summary" role="alert" tabIndex={-1} aria-labelledby="canonical-consistency-error-summary-label"><span id="canonical-consistency-error-summary-label">错误摘要：</span>{errorCodes.map((code) => <Tag key={code}>{codeMessage(code)}</Tag>)}</div>}</div>} style={{ marginBottom: 16 }} />}
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">工作区：{report.workspaceId}</Typography.Text>
        {report.readMode && <Tag>{report.readMode === "live" ? "实时读取" : "快照读取"}</Tag>}
        {report.read_control && <Tag color={report.read_control.mode === "canonical_read" ? "green" : "gold"}>切读：{report.read_control.mode}</Tag>}
        {report.revision && <Typography.Text type="secondary">检查 revision：{String(report.revision).slice(0, 12)}…</Typography.Text>}
        {report.unified_link_audit && <Typography.Text type="secondary">审计记录：{report.unified_link_audit.items?.length ?? report.unified_link_audit.count}</Typography.Text>}
        {report.generatedAt && <Typography.Text type="secondary">生成于：{report.generatedAt}</Typography.Text>}
      </Space>
      <Row gutter={[16, 16]}>
        {(Object.keys(statusMeta) as Status[]).map(status => <Col xs={12} md={6} key={status}><Statistic title={statusMeta[status].label} value={report.counts[status]} /></Col>)}
      </Row>
      <Space orientation="vertical" style={{ width: "100%", marginTop: 20 }} size={12}>
        <Typography.Text strong>商品级检查结果</Typography.Text>
        <Segmented className="canonical-consistency-filter" aria-label="一致性状态筛选" value={filter} onChange={value => setFilter(value as "all" | Status)} options={[{ label: "全部", value: "all" }, ...Object.entries(statusMeta).map(([value, meta]) => ({ label: meta.label, value }))]} />
        {findings.length ? <Table rowKey="legacyProductId" size="small" pagination={{ pageSize: 10, showSizeChanger: false }} dataSource={findings} columns={[
          { title: "旧商品 ID", dataIndex: "legacyProductId", ellipsis: true },
          { title: "规范商品 ID", dataIndex: "canonicalProductId", render: (value: string | undefined) => value ?? "—" },
          { title: "关系引用", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => `${row.listingIds.length} listing / ${row.taskIds.length} task` },
          { title: "证据时间", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => row.evidence?.generatedAt ?? "未返回" },
          { title: "原因", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => row.codes.length ? row.codes.map(codeMessage).join("、") : "关系链已验证" },
          { title: "状态", dataIndex: "status", render: (value: Status) => <Tag color={statusMeta[value].color} icon={value === "verified" ? <CheckCircleOutlined /> : <WarningOutlined />}>{statusMeta[value].label}</Tag> },
          { title: "下一步", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => <NextActionEvidence finding={row} onExecute={onNextAction} /> },
          { title: "操作", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => <Button className="canonical-consistency-action" type="link" aria-label={`查看 ${row.legacyProductId} 一致性详情`} onClick={() => setSelected(row)}>查看详情</Button> },
        ]} /> : report.findings.length === 0 && report.orphanFindings.length === 0 ? <Alert
          type={report.status === "clean" && !hasAttention ? "success" : "warning"}
          showIcon
          role={report.status === "clean" && !hasAttention ? "status" : "alert"}
          title={report.status === "clean" && !hasAttention ? "当前没有关系问题" : "没有可验证的关系记录"}
          description={report.status === "clean" && !hasAttention ? "服务端返回了空的一致性结果；这不是客户端未加载。" : "服务端未返回可验证商品关系，当前不能据此判断已通过。请重新检查或转人工处理。"}
        /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选没有商品；请调整状态筛选" />}
        {orphanFindings.length > 0 && <>
          <Typography.Text strong>未挂接关系对象</Typography.Text>
          <Typography.Text type="secondary">这些对象不属于任何可验证的商品行，必须单独处理；系统不会根据数量摘要推断其已通过。</Typography.Text>
          <Table rowKey={(row) => `${row.entityType}:${row.entityId}`} size="small" pagination={{ pageSize: 10, showSizeChanger: false }} dataSource={orphanFindings} columns={[
            { title: "对象类型", dataIndex: "entityType", render: (value: keyof typeof orphanEntityMeta) => orphanEntityMeta[value] ?? value },
            { title: "对象 ID", dataIndex: "entityId", ellipsis: true, render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text> },
            { title: "状态", dataIndex: "status", render: (value: "conflict" | "blocked") => <Tag color={statusMeta[value].color} icon={<WarningOutlined />}>{statusMeta[value].label}</Tag> },
            { title: "阻断原因", dataIndex: "codes", render: (codes: string[]) => codes.map(codeMessage).join("、") },
            { title: "操作", render: (_: unknown, row: CanonicalProductConsistencyReport["orphanFindings"][number]) => <Button className="canonical-consistency-action" type="link" aria-label={`查看 ${row.entityId} 关系详情`} onClick={() => setSelectedOrphan(row)}>查看详情</Button> },
          ]} />
        </>}
      </Space>
    </Card>
    <Drawer title="一致性详情" open={Boolean(selected)} onClose={() => setSelected(undefined)} size={480} destroyOnClose>
      {selected && <Space orientation="vertical" style={{ width: "100%" }} size={16}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="旧商品 ID">{selected.legacyProductId}</Descriptions.Item>
          <Descriptions.Item label="商品对象 ID">{selected.productId ?? selected.legacyProductId}</Descriptions.Item>
          <Descriptions.Item label="规范商品 ID">{selected.canonicalProductId ?? "未映射"}</Descriptions.Item>
          <Descriptions.Item label="状态"><Tag color={statusMeta[selected.status].color}>{statusMeta[selected.status].label}</Tag></Descriptions.Item>
          <Descriptions.Item label="品牌 / 平台 / 店铺">{selected.scope ? `${selected.scope.brandId ?? "未绑定品牌"} / ${selected.scope.platform ?? "未绑定平台"} / ${selected.scope.accountId ?? "未绑定店铺"}` : "服务端未返回范围"}</Descriptions.Item>
          <Descriptions.Item label="Listing">{selected.relation?.listingIds.join(", ") || selected.listingIds.join(", ") || "无"}</Descriptions.Item>
          <Descriptions.Item label="批次 / 任务 / 发布">{selected.relation ? `${selected.relation.campaignItemIds.length} / ${selected.relation.taskIds.length} / ${selected.relation.publishJobIds.length}` : `${selected.campaignItemIds.length} / ${selected.taskIds.length} / ${selected.publishJobIds.length}`}</Descriptions.Item>
          <Descriptions.Item label="检查证据">{selected.evidence ? `${selected.evidence.generatedAt} · revision ${selected.evidence.revision ?? "—"}` : "服务端未返回证据摘要"}</Descriptions.Item>
        </Descriptions>
        <Alert type={selected.status === "verified" ? "info" : "warning"} showIcon title="下一步" description={<NextActionEvidence finding={selected} onExecute={onNextAction} />} />
        {selected.blocking && <Alert type="error" showIcon title={`阻断：${selected.blocking.code}`} description={`${selected.blocking.message} ${selected.blocking.impact}`} />}
        {selected.codes.length ? <Alert type="error" showIcon title="阻断原因" description={<ul>{selected.codes.map(code => <li key={code}><Typography.Text code>{code}</Typography.Text>：{codeMessage(code)}</li>)}</ul>} /> : selected.evidence ? <Alert type="success" showIcon title="关系链已验证" /> : <Alert type="warning" showIcon title="验证证据不完整" description="服务端未返回该商品的证据摘要，当前不能作为发布依据。" />}
      </Space>}
    </Drawer>
    <Drawer title="未挂接关系详情" open={Boolean(selectedOrphan)} onClose={() => setSelectedOrphan(undefined)} size={480} destroyOnClose>
      {selectedOrphan && <Space orientation="vertical" style={{ width: "100%" }} size={16}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="对象类型">{orphanEntityMeta[selectedOrphan.entityType]}</Descriptions.Item>
          <Descriptions.Item label="对象 ID">{selectedOrphan.entityId}</Descriptions.Item>
          <Descriptions.Item label="状态"><Tag color={statusMeta[selectedOrphan.status].color}>{statusMeta[selectedOrphan.status].label}</Tag></Descriptions.Item>
        </Descriptions>
        <Alert type="warning" showIcon title="当前对象未挂接到可验证商品链" description="请由具备服务端授权的运营人员按错误码处理；本页面不提供自动绑定、删除或强制放行。" />
        <Alert type="error" showIcon title="阻断原因" description={<ul>{selectedOrphan.codes.map(code => <li key={code}><Typography.Text code>{code}</Typography.Text>：{codeMessage(code)}</li>)}</ul>} />
      </Space>}
    </Drawer>
  </>;
}
