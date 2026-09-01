import { ApartmentOutlined } from "@ant-design/icons";
import { Alert, Card, Col, Empty, Row, Statistic, Table, Tag, Typography } from "antd";
import type { CanonicalProductConsistencyReport } from "../../types/ops.js";

const statusMeta = {
  verified: { label: "已验证", color: "green" },
  legacy_only: { label: "仅旧链路", color: "gold" },
  conflict: { label: "存在冲突", color: "red" },
  blocked: { label: "已阻断", color: "orange" },
} as const;

export function CanonicalConsistencySummary({ report }: { report?: CanonicalProductConsistencyReport }) {
  if (!report) return <Card title={<><ApartmentOutlined aria-hidden="true" /> 标准商品链一致性</>}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未取得标准商品链检查结果" /></Card>;
  const rows = report.findings;
  return (
    <Card title={<><ApartmentOutlined aria-hidden="true" /> 标准商品链一致性</>} extra={<Tag color={report.status === "clean" ? "green" : "orange"}>{report.status === "clean" ? "链路正常" : "需要处理"}</Tag>}>
      <Typography.Paragraph type="secondary">按当前工作区的明确映射展示 legacy 商品、canonical 商品、listing 与任务链路；不根据缺失数据推断为正常。</Typography.Paragraph>
      {report.status !== "clean" && <Alert type="warning" showIcon title="部分商品链路需要处理" description={`发现 ${report.counts.conflict + report.counts.blocked + report.counts.legacy_only} 条非已验证记录，请按商品逐项修复映射或店铺 listing。`} />}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>{(Object.keys(statusMeta) as Array<keyof typeof statusMeta>).map((status) => <Col xs={12} md={6} key={status}><Statistic title={statusMeta[status].label} value={report.counts[status]} /></Col>)}</Row>
      {rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有商品级一致性记录" /> : <Table style={{ marginTop: 16 }} rowKey="legacyProductId" size="small" pagination={{ pageSize: 8 }} dataSource={rows} columns={[
        { title: "旧商品 ID", dataIndex: "legacyProductId", render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text> },
        { title: "标准商品 ID", dataIndex: "canonicalProductId", render: (value?: string) => value ?? "未映射" },
        { title: "状态", dataIndex: "status", render: (value: keyof typeof statusMeta) => <Tag color={statusMeta[value].color}>{statusMeta[value].label}</Tag> },
        { title: "问题码", dataIndex: "codes", render: (codes: string[]) => codes.length ? codes.join("、") : "—" },
      ]} />}
      {report.orphanFindings.length > 0 && <Typography.Text type="secondary">另有 {report.orphanFindings.length} 条未挂接实体记录，需要在标准商品链中处理。</Typography.Text>}
    </Card>
  );
}
