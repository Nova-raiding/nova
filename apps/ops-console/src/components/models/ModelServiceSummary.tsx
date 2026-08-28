import { ArrowRightOutlined } from "@ant-design/icons";
import { Button, Card, Col, Row, Statistic, Tag, Typography } from "antd";
import type { ModelStatus } from "../../types/ops";
import { modelReadinessRows } from "../sections/overview/modelReadiness";

interface ModelServiceSummaryProps {
  status: ModelStatus | undefined;
  loading: boolean;
  onOpen: () => void;
}

export function ModelServiceSummary({ status, loading, onOpen }: ModelServiceSummaryProps) {
  const rows = modelReadinessRows(status);
  const readyCount = rows.filter((row) => row.ready).length;
  const blockedCount = rows.length - readyCount;

  return (
    <Card
      title="模型服务"
      extra={
        <Button type="link" onClick={onOpen}>
          进入模型服务 <ArrowRightOutlined aria-hidden="true" />
        </Button>
      }
    >
      <Row gutter={[16, 16]} align="middle">
        <Col xs={12} md={6}>
          <Statistic title="已就绪能力" value={readyCount} suffix={`/ ${rows.length}`} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="阻断能力" value={blockedCount} />
        </Col>
        <Col xs={24} md={12}>
          <Tag color={!status ? "default" : status.state === "ready" ? "green" : "red"}>
            {loading && !status ? "加载中" : status?.state ?? "状态不可用"}
          </Tag>
          <Typography.Text type="secondary">
            Provider 配置不代表可用，最终状态同时受成本证据与计费组门禁控制。
          </Typography.Text>
        </Col>
      </Row>
    </Card>
  );
}
