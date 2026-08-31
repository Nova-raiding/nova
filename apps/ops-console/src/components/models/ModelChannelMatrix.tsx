import { Alert, Card, Table, Tag, Typography } from "antd";
import type { ModelStatus } from "../../types/ops";

const modalityConfig = [
  { key: "text", label: "文本", modelKey: "text_model", capabilityKey: "text_generation" },
  { key: "image", label: "图片", modelKey: "image_model", capabilityKey: "image_generation" },
  { key: "image_edit", label: "图片编辑", modelKey: "image_model", capabilityKey: "image_editing" },
  { key: "ocr", label: "OCR", modelKey: "vision_model", capabilityKey: "image_fact_ocr" },
  { key: "video", label: "视频", modelKey: "video_model", capabilityKey: "video_rendering" },
] as const;

export type ModelChannelRow = {
  key: string;
  label: string;
  model: string | null;
  providerConfigured: boolean;
  ready: boolean;
  costEvidence: boolean;
  reasons: string[];
};

export function modelChannelRows(status: ModelStatus | undefined): ModelChannelRow[] {
  return modalityConfig.map((config) => {
    const readiness = status?.model_readiness?.[config.key];
    return {
      key: config.key,
      label: config.label,
      model: status?.[config.modelKey] ?? null,
      providerConfigured: readiness?.provider_configured === true,
      ready: status?.capabilities[config.capabilityKey] === true && readiness?.ready === true,
      costEvidence: status?.cost_evidence_by_modality?.[config.key] === true,
      reasons: readiness?.reasons ?? [],
    };
  });
}

interface ModelChannelMatrixProps {
  status: ModelStatus | undefined;
}

export function ModelChannelMatrix({ status }: ModelChannelMatrixProps) {
  const rows = modelChannelRows(status);
  const groupEvidenceReady = rows.every((row) => row.costEvidence);

  return (
    <Card title="模型渠道与 SVIP 上线门禁">
      <Alert
        type={groupEvidenceReady ? "success" : "warning"}
        showIcon
        title={groupEvidenceReady ? "全部模态已有实际计费组成本证据" : "部分模态缺少实际计费组成本证据"}
        description="控制台不会显示中转站密钥。SVIP 是否可上线以服务端返回的实际计费组、价格快照和成本证据门禁为准；仅填写模型名不代表可用。"
      />
      <Table<ModelChannelRow>
        rowKey="key"
        size="small"
        pagination={false}
        scroll={{ x: 900 }}
        dataSource={rows}
        columns={[
          { title: "能力", dataIndex: "label", fixed: "left", width: 120 },
          {
            title: "模型渠道",
            dataIndex: "model",
            width: 220,
            render: (value: string | null) => <Typography.Text className="ops-token">{value ?? "未配置"}</Typography.Text>,
          },
          {
            title: "Provider",
            dataIndex: "providerConfigured",
            width: 120,
            render: (value: boolean) => <Tag color={value ? "blue" : "default"}>{value ? "已配置" : "未配置"}</Tag>,
          },
          {
            title: "实际成本证据",
            dataIndex: "costEvidence",
            width: 150,
            render: (value: boolean) => <Tag color={value ? "green" : "red"}>{value ? "已验证" : "缺失"}</Tag>,
          },
          {
            title: "最终状态",
            dataIndex: "ready",
            width: 120,
            render: (value: boolean) => <Tag color={value ? "green" : "red"}>{value ? "可用" : "阻断"}</Tag>,
          },
          {
            title: "阻断原因",
            dataIndex: "reasons",
            render: (value: string[], row: ModelChannelRow) => row.ready ? "—" : value.join("；") || "尚未通过模型、计费组或成本门禁",
          },
        ]}
      />
    </Card>
  );
}
