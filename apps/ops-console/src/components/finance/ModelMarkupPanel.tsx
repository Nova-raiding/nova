import { Alert, Button, Card, Input, InputNumber, Space, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

interface ModelMarkupPanelProps {
  model: OpsConsoleModel;
}

export function ModelMarkupPanel({ model }: ModelMarkupPanelProps) {
  const {
    modelMarkup,
    setModelMarkup,
    modelMarkupLoading,
    modelMarkupError,
    modelMarkupReason,
    setModelMarkupReason,
    canModelMarkup,
    canModelMarkupUpdate,
    saveModelMarkup,
  } = model;

  return (
    <Card
      size="small"
      title="Token 成本倍率"
      extra={<Tag color="blue">Revision {modelMarkup?.revision ?? "-"}</Tag>}
    >
      {modelMarkupError ? (
        <Alert
          showIcon
          type="error"
          title="计费倍率读取失败"
          description={modelMarkupError}
          action={
            <Button size="small" onClick={() => void model.loadModelMarkup()}>
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Space wrap align="end">
        <div>
          <Typography.Text strong>计费倍率</Typography.Text>
          <br />
          <InputNumber
            aria-label="Token 计费倍率"
            disabled={!canModelMarkupUpdate || !modelMarkup || modelMarkupLoading}
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
            !canModelMarkupUpdate || !modelMarkup || modelMarkupLoading || !modelMarkupReason.trim()
          }
          loading={modelMarkupLoading}
          onClick={() => void saveModelMarkup()}
        >
          保存并生效
        </Button>
      </Space>
      {!modelMarkupLoading && !modelMarkup && !modelMarkupError ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          尚未读取到全局倍率配置，当前不能编辑。请点击重试或检查运营 API 与数据库迁移状态。
        </Typography.Paragraph>
      ) : null}
      {modelMarkup && !canModelMarkupUpdate ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          当前账号只有读取权限；修改倍率需要 `commercial.update`。
        </Typography.Paragraph>
      ) : null}
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
