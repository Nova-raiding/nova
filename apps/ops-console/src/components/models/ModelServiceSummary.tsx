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
          <Statistic title="已就绪能力" value={status ? readyCount : "暂无数据"} suffix={status ? `/ ${rows.length}` : undefined} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="阻断能力" value={status ? blockedCount : "暂无数据"} />
        </Col>
        <Col xs={24} md={12}>
          <Tag color={!status ? "default" : status.state === "ready" ? "green" : "red"}>
            {loading && !status ? "加载中" : status?.state ?? "状态不可用"}
          </Tag>
          <Typography.Text type="secondary">
            运行时状态与发布证据分别核验；Provider 配置不代表生产可用。当前 release metadata{" "}
            {status?.release_metadata_ready ? "已就绪" : "未就绪"}，完整发布门禁仍由服务端决定。
          </Typography.Text>
        </Col>
      </Row>
    </Card>
  );
}
