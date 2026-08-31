import { ArrowRightOutlined } from "@ant-design/icons";
import { Button, Card, Col, Row, Statistic, Tag, Typography } from "antd";
import type { StorageReconciliationSummary as StorageSummary } from "../../types/ops";

interface StorageReconciliationSummaryProps {
  summary?: StorageSummary;
  onOpen: () => void;
}

function bytes(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function StorageReconciliationSummary({ summary, onOpen }: StorageReconciliationSummaryProps) {
  const unavailable = !summary || summary.status === "unavailable";
  const failed = summary?.runStatus === "failed" || summary?.status === "failed";
  const attention = summary?.status === "attention_required";
  const counts = summary?.counts;

  return (
    <Card
      title="存储与对账"
      extra={<Button type="link" onClick={onOpen}>查看对账 <ArrowRightOutlined aria-hidden="true" /></Button>}
    >
      <Row gutter={[16, 16]} align="middle">
        <Col xs={12} md={6}><Statistic title="已使用" value={bytes(summary?.quota?.usedBytes)} /></Col>
        <Col xs={12} md={6}><Statistic title="预计占用" value={bytes(summary?.quota?.projectedBytes)} /></Col>
        <Col xs={24} md={6}>
          <Tag color={unavailable ? "default" : failed ? "red" : attention ? "orange" : "green"}>
            {unavailable ? "尚未接入" : failed ? "对账失败" : attention ? "需要处理" : "对账正常"}
          </Tag>
        </Col>
        <Col xs={24} md={6}>
          <Typography.Text type="secondary">
            {counts ? `${counts.missing + counts.orphans + counts.metadataMismatches} 项一致性问题` : "仅展示 workspace 汇总"}
          </Typography.Text>
        </Col>
      </Row>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {summary?.lastRunAt ? `最近对账：${summary.lastRunAt}` : "暂无最近对账时间"}；不展示客户对象、key 或下载入口。
      </Typography.Paragraph>
    </Card>
  );
}
