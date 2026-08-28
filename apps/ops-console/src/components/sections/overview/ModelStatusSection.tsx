import {
  Alert,
  Card,
  Col,
  Row,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import {
  modelCostReadiness,
  modelReadinessRows,
  type ModelReadinessRow,
} from "./modelReadiness";

interface OverviewSectionProps {
  model: OpsConsoleModel;
}

export function ModelStatusSection({ model }: OverviewSectionProps) {
  const { modelStatus, modelStatusLoading } = model;
  const readinessRows = modelReadinessRows(modelStatus);
  const costReadiness = modelCostReadiness(modelStatus);
  return (
    <>
      <Card
        title="平台模型服务"
        extra={
          <Tag color={!modelStatus ? "default" : modelStatus.state === "ready" ? "green" : "red"}>
            {modelStatus?.state ?? "加载中"}
          </Tag>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={6}>
            <Statistic title="模型归属" value="平台统一" />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="自有中转站"
              value={modelStatus?.relay?.configured ? "已配置" : "未配置"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="文案模型"
              value={modelStatus?.text_model ?? "-"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="图片模型"
              value={modelStatus?.image_model ?? "-"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="OCR 模型"
              value={modelStatus?.vision_model ?? "-"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="视频模型"
              value={modelStatus?.video_model ?? "-"}
            />
          </Col>
        </Row>
        <Typography.Paragraph type="secondary">
          用户不能填写或绑定模型
          Key；平台负责模型费用，商家通过充值和套餐额度使用插件能力。中转站{" "}
          {modelStatus?.relay?.host ?? "-"}。RPM {modelStatus?.quotas.rpm ?? "-"}，TPM{" "}
          {modelStatus?.quotas.tpm ?? "-"}，日成本上限{" "}
          {modelStatus?.quotas.daily_cny_limit ?? "-"} 元。发布元数据{" "}
          {modelStatus?.release_metadata_ready ? "已就绪" : "未就绪"}。
        </Typography.Paragraph>
        <Table<ModelReadinessRow>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={readinessRows}
          columns={[
            { title: "能力", dataIndex: "label" },
            {
              title: "Provider 配置",
              dataIndex: "providerConfigured",
              render: (configured: boolean) => (
                <Tag color={configured ? "blue" : "default"}>
                  {configured ? "已配置" : "未配置"}
                </Tag>
              ),
            },
            {
              title: "最终 readiness",
              dataIndex: "ready",
              render: (ready: boolean) => (
                <Tag color={ready ? "green" : "red"}>
                  {ready ? "可用" : "阻断"}
                </Tag>
              ),
            },
            {
              title: "阻断原因",
              dataIndex: "reasons",
              render: (reasons: string[], row: ModelReadinessRow) =>
                row.ready
                  ? "—"
                  : reasons.join("；") || "尚未通过最终运行与商业门禁",
            },
          ]}
        />
        {modelStatus && (
          <Alert
            type={costReadiness.ready ? "success" : "error"}
            showIcon
            title={`成本与计费组：${costReadiness.ready ? "已就绪" : "阻断"}`}
            description={
              costReadiness.ready
                ? "成本上限、实际成本证据和当前计费组均已通过门禁。"
                : costReadiness.blockers.join("；") ||
                  "实际成本证据、价格快照或当前计费组尚未通过验证。"
            }
          />
        )}
        {!modelStatus ? (
          <Alert
            type="info"
            showIcon
            title={modelStatusLoading ? "正在加载平台模型状态" : "平台模型状态不可用"}
            description={modelStatusLoading ? "请稍候，正在读取中转站与成本门禁。" : "请检查页面顶部错误并重试，当前状态不能视为配置完成。"}
          />
        ) : modelStatus.next_actions.length ? (
          <Alert
            type="warning"
            showIcon
            title="模型上线门禁"
            description={modelStatus.next_actions.join("；")}
          />
        ) : (
          <Alert type="success" showIcon title="平台模型配置完整" />
        )}
      </Card>
    </>
  );
}
