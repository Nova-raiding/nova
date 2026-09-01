import { ApartmentOutlined } from "@ant-design/icons";
import { Card, Col, Empty, Row, Statistic, Tag, Typography } from "antd";
import type { PlatformBrandUnitSummary } from "../../types/ops.js";

export function BrandGovernanceSummary({ summary }: { summary?: PlatformBrandUnitSummary }) {
  if (!summary) return <Card title={<><ApartmentOutlined aria-hidden="true" /> 品牌治理聚合</>}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未取得平台品牌聚合数据" /></Card>;
  return <Card title={<><ApartmentOutlined aria-hidden="true" /> 品牌治理聚合 <Tag color="blue">平台级脱敏</Tag></>}>
    <Typography.Paragraph type="secondary">仅展示数量和链路健康，不返回品牌名称、商品标题、内容或令牌。</Typography.Paragraph>
    <Row gutter={[16, 16]}>
      <Col xs={12} md={6}><Statistic title="品牌数" value={summary.brandCount} /></Col>
      <Col xs={12} md={6}><Statistic title="已绑定店铺" value={summary.boundStoreCount} /></Col>
      <Col xs={12} md={6}><Statistic title="未绑定品牌" value={summary.unboundBrandCount} styles={{ content: { color: summary.unboundBrandCount ? "#d97706" : undefined } }} /></Col>
      <Col xs={12} md={6}><Statistic title="刊登映射" value={summary.listingCount} /></Col>
    </Row>
  </Card>;
}
