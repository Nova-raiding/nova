import { Alert, Card, Col, Row, Statistic, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { ModelReadinessTable } from "./ModelReadinessTable";

interface ModelStatusSectionProps {
  model: OpsConsoleModel;
}

export function ModelStatusSection({ model }: ModelStatusSectionProps) {
  const { modelStatus, modelStatusLoading } = model;

  return (
    <Card
      title="模型服务诊断"
      extra={
        <Tag color={!modelStatus ? "default" : modelStatus.state === "ready" ? "green" : "red"}>
          {modelStatus?.state ?? "加载中"}
        </Tag>
      }
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="模型归属" value="平台统一" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="自有中转站" value={modelStatus?.relay?.configured ? "已配置" : "未配置"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="文案模型" value={modelStatus?.text_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="图片模型" value={modelStatus?.image_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="OCR 模型" value={modelStatus?.vision_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="视频模型" value={modelStatus?.video_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="RPM" value={modelStatus?.quotas.rpm ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="日成本上限（元）" value={modelStatus?.quotas.daily_cny_limit ?? "-"} />
        </Col>
      </Row>
      <Typography.Paragraph type="secondary">
        用户不能填写或绑定模型 Key；平台负责模型费用，商家通过充值和套餐额度使用插件能力。中转站{" "}
        {modelStatus?.relay?.host ?? "-"}，TPM {modelStatus?.quotas.tpm ?? "-"}，发布元数据{" "}
        {modelStatus?.release_metadata_ready ? "已就绪" : "未就绪"}。
      </Typography.Paragraph>
      <ModelReadinessTable status={modelStatus} />
      {!modelStatus ? (
        <Alert
          type="info"
          showIcon
          title={modelStatusLoading ? "正在加载平台模型状态" : "平台模型状态不可用"}
          description={
            modelStatusLoading
              ? "请稍候，正在读取中转站与成本门禁。"
              : "请检查页面顶部错误并重试，当前状态不能视为配置完成。"
          }
        />
      ) : modelStatus.next_actions.length ? (
        <Alert type="warning" showIcon title="模型上线门禁" description={modelStatus.next_actions.join("；")} />
      ) : (
        <Alert type="success" showIcon title="平台模型配置完整" />
      )}
    </Card>
  );
}
