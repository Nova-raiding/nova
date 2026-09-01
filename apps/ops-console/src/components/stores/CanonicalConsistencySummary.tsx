import { ApartmentOutlined } from "@ant-design/icons";
import { Alert, Card, Col, Empty, Row, Statistic, Table, Tag, Typography } from "antd";
import type { CanonicalProductConsistencyReport } from "../../types/ops.js";

const statusMeta = {
  verified: { label: "已验证", color: "green" },
  legacy_only: { label: "仅旧链路", color: "gold" },
  conflict: { label: "存在冲突", color: "red" },
  blocked: { label: "已阻断", color: "orange" },
} as const;

const codeMessage = (code: string) => ({
  CANONICAL_MAPPING_MISSING: "未找到规范商品映射",
  CANONICAL_MAPPING_AMBIGUOUS: "存在多个规范商品映射，无法自动判断",
  LISTING_MAPPING_MISSING: "当前平台店铺缺少 listing 映射",
}[code] ?? code);

function reportState(report: CanonicalProductConsistencyReport) {
  if (report.availability === "unavailable" || report.contractStatus === "unavailable") return { kind: "error" as const, title: "一致性数据暂不可读取", description: "服务端没有返回可验证数据；这不是零结果，请重试或联系具备权限的运营人员。" };
  if (report.availability === "unknown" || report.contractStatus === "unknown" || report.freshness === "expired" || report.freshness === "unknown") return { kind: "warning" as const, title: "一致性结果尚未确认", description: "当前结果不能视为已验证，也不能据此继续发布；请重新检查并等待新的服务端证据。" };
  if (report.freshness === "stale") return { kind: "warning" as const, title: "一致性结果已变旧", description: "结果可能未覆盖最新关系；处理前请重新检查。" };
  return undefined;
}

function nextActionLabel(finding: CanonicalProductConsistencyReport["findings"][number]) {
  const action = finding.nextAction;
  if (!action) return finding.status === "verified" ? "无需修复；继续动作仍需通过发布门禁" : "服务端未提供动作，保持只读";
  return action.permission.allowed
    ? `服务端动作：${action.label}`
    : `${action.label}（需要 ${action.permission.requiredRole ?? "指定角色"} 权限）`;
}

export function CanonicalConsistencySummary({ report }: { report?: CanonicalProductConsistencyReport }) {
  if (!report) return <Card title={<><ApartmentOutlined aria-hidden="true" /> 标准商品链一致性</>}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未取得标准商品链检查结果" /></Card>;
  const rows = report.findings;
  const state = reportState(report);
  return (
    <Card title={<><ApartmentOutlined aria-hidden="true" /> 标准商品链一致性</>} extra={<Tag color={report.status === "clean" && !state ? "green" : "orange"}>{report.status === "clean" && !state ? "链路正常" : "需要处理"}</Tag>}>
      <Typography.Paragraph type="secondary">按当前工作区的明确映射展示 legacy 商品、canonical 商品、listing 与任务链路；不根据缺失数据推断为正常。</Typography.Paragraph>
      {state && <Alert role="alert" type={state.kind} showIcon title={state.title} description={state.description} />}
      {report.status !== "clean" && <Alert type="warning" showIcon title="部分商品链路需要处理" description={`发现 ${report.counts.conflict + report.counts.blocked + report.counts.legacy_only} 条非已验证记录，请按商品逐项修复映射或店铺 listing。`} />}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>{(Object.keys(statusMeta) as Array<keyof typeof statusMeta>).map((status) => <Col xs={12} md={6} key={status}><Statistic title={statusMeta[status].label} value={report.counts[status]} /></Col>)}</Row>
      {rows.length === 0 ? <Alert role={state ? "alert" : "status"} type={state ? "warning" : "success"} showIcon title={state ? "没有可验证的商品记录" : "当前没有商品级一致性记录"} description={state ? "空结果不代表已验证；请重新检查或转人工处理。" : "服务端返回了真实零结果，不是客户端未加载。"} /> : <Table style={{ marginTop: 16 }} rowKey="legacyProductId" size="small" pagination={{ pageSize: 8 }} dataSource={rows} columns={[
        { title: "旧商品 ID", dataIndex: "legacyProductId", render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text> },
        { title: "标准商品 ID", dataIndex: "canonicalProductId", render: (value?: string) => value ?? "未映射" },
        { title: "状态", dataIndex: "status", render: (value: keyof typeof statusMeta) => <Tag color={statusMeta[value].color}>{statusMeta[value].label}</Tag> },
        { title: "问题码", dataIndex: "codes", render: (codes: string[]) => codes.length ? codes.join("、") : "—" },
        { title: "关系引用", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => `${row.listingIds.length} listing / ${row.taskIds.length} task / ${row.publishJobIds.length} publish` },
        { title: "证据时间", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => row.evidence?.generatedAt ?? "未返回" },
        { title: "下一步", render: (_: unknown, row: CanonicalProductConsistencyReport["findings"][number]) => <Typography.Text type={row.status === "verified" ? "secondary" : "warning"}>{nextActionLabel(row)}</Typography.Text> },
      ]} />}
      {report.orphanFindings.length > 0 && <Typography.Text type="secondary">另有 {report.orphanFindings.length} 条未挂接实体记录，需要在标准商品链中处理。</Typography.Text>}
    </Card>
  );
}
