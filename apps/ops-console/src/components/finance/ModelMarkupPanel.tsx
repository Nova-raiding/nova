import { Button, Card, Input, InputNumber, Space, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

interface ModelMarkupPanelProps {
  model: OpsConsoleModel;
}

export function ModelMarkupPanel({ model }: ModelMarkupPanelProps) {
  const {
    modelMarkup,
    setModelMarkup,
    modelMarkupReason,
    setModelMarkupReason,
    canModelMarkup,
    saveModelMarkup,
  } = model;

  return (
    <Card
      size="small"
      title="Token 成本倍率"
      extra={<Tag color="blue">Revision {modelMarkup?.revision ?? "-"}</Tag>}
    >
      <Space wrap align="end">
        <div>
          <Typography.Text strong>计费倍率</Typography.Text>
          <br />
          <InputNumber
            aria-label="Token 计费倍率"
            disabled={!canModelMarkup || !modelMarkup}
            min={1}
            max={10}
            step={0.1}
            precision={3}
            value={modelMarkup?.multiplier}
            onChange={(value) =>
              setModelMarkup((current) =>
                current
                  ? {
                      ...current,
                      multiplier: Number(value ?? 2.5),
                    }
                  : current,
              )
            }
          />
        </div>
        <div>
          <Typography.Text strong>变更原因</Typography.Text>
          <br />
          <Input
            aria-label="Token 计费倍率变更原因"
            disabled={!canModelMarkup}
            value={modelMarkupReason}
            onChange={(event) => setModelMarkupReason(event.target.value)}
            placeholder="必填，写入审计"
            style={{ width: 280 }}
          />
        </div>
        <Button
          type="primary"
          disabled={
            !canModelMarkup || !modelMarkup || !modelMarkupReason.trim()
          }
          onClick={() => void saveModelMarkup()}
        >
          保存并生效
        </Button>
      </Space>
      <Typography.Paragraph
        type="secondary"
        style={{ marginTop: 12, marginBottom: 0 }}
      >
        用户应付 = 中转站返回的实际成本 × 当时倍率。默认 2.5
        倍；历史账单保留生成时的倍率和版本，修改后不回溯重算。
      </Typography.Paragraph>
    </Card>
  );
}
