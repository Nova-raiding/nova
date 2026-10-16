import { ApartmentOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Empty, Row, Skeleton, Statistic, Tag, Typography } from "antd";
import type { PlatformBrandUnitSummary } from "../../types/ops.js";

interface BrandGovernanceSummaryProps {
  summary?: PlatformBrandUnitSummary;
  loading?: boolean;
  error?: string;
  fixtureDataPresent?: boolean;
  onRetry?: () => void;
}

export function BrandGovernanceSummary({ summary, loading = false, error, fixtureDataPresent = false, onRetry }: BrandGovernanceSummaryProps) {
  const title = <><ApartmentOutlined aria-hidden="true" /> 品牌治理聚合</>;
  if (loading) return <Card className="ops-brand-governance-summary" title={title} aria-busy="true"><div role="status" aria-label="正在读取品牌汇总"><Skeleton active paragraph={{ rows: 2 }} /></div></Card>;
  if (error || fixtureDataPresent) return <Card className="ops-brand-governance-summary" title={title}><Alert type="warning" showIcon title={error ? "品牌汇总读取失败" : "品牌汇总尚未核验"} description={error || "当前测试数据不能作为真实品牌与店铺数量的依据。"} action={onRetry ? <Button onClick={onRetry}>重新读取</Button> : undefined} /></Card>;
  if (!summary) return <Card className="ops-brand-governance-summary" title={title}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未取得平台品牌聚合数据" /></Card>;
  return <Card className="ops-brand-governance-summary" title={<><ApartmentOutlined aria-hidden="true" /> 品牌治理聚合 <Tag color="blue">平台级脱敏</Tag></>}>
    <Typography.Paragraph type="secondary">仅展示数量和链路健康，不返回品牌名称、商品标题、内容或令牌。</Typography.Paragraph>
    <Row gutter={[16, 16]}>
      <Col xs={12} md={6}><Statistic title="品牌数" value={summary.brandCount} /></Col>
      <Col xs={12} md={6}><Statistic title="已绑定店铺" value={summary.boundStoreCount} /></Col>
      <Col xs={12} md={6}><Statistic title="未绑定品牌" value={summary.unboundBrandCount} styles={{ content: { color: summary.unboundBrandCount ? "#d97706" : undefined } }} /></Col>
      <Col xs={12} md={6}><Statistic title="刊登映射" value={summary.listingCount} /></Col>
    </Row>
  </Card>;
}
