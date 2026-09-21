import { ArrowRightOutlined } from "@ant-design/icons";
import { Button, Card, Col, Row, Statistic, Tag, Typography } from "antd";
import type { ModelStatus } from "../../types/ops";
import { modelReadinessRows, modelStateLabel } from "../sections/overview/modelReadiness";

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
          <Tag color={!status ? "default" : status.state === "ready" ? "blue" : "red"}>
            {loading && !status ? "加载中" : status ? modelStateLabel(status.state) : "状态不可用"}
          </Tag>
          <Typography.Text type="secondary">
            Provider 配置和模型运行 ready 都不代表生产门禁通过。模型状态接口中的插件构建字段标记{" "}
            {status?.release_metadata_ready ? "已返回" : "未通过"}；该标记不是 /api/releasez 发布身份，本卡不能判定全局发布状态。
          </Typography.Text>
        </Col>
      </Row>
    </Card>
  );
}
