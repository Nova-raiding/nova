import { Button, Card, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { UploadedAssetRisk } from "../../../types/ops";

interface UploadedAssetGovernanceProps {
  model: OpsConsoleModel;
}

export function UploadedAssetGovernance({
  model,
}: UploadedAssetGovernanceProps) {
  const { canKnowledge, governUploadedAsset, marketingQueue } = model;
  const [target, setTarget] = useState<UploadedAssetRisk>();
  const [evidence, setEvidence] = useState("");
  const [rightsStatus, setRightsStatus] = useState("approved");
  const [rightsScope, setRightsScope] = useState("commercial_authorized");
  const [factsJson, setFactsJson] = useState("{}");
  const [reason, setReason] = useState("运营审核补录");
  const [submitting, setSubmitting] = useState(false);
  const close = () => { if (!submitting) { setTarget(undefined); setEvidence(""); setFactsJson("{}"); setReason(""); } };
  const open = (row: UploadedAssetRisk) => { setTarget(row); setEvidence(""); setRightsStatus("approved"); setRightsScope("commercial_authorized"); setFactsJson("{}"); setReason("运营审核补录"); };
  const method = target?.nextAction?.method;
  const canSubmit = method === "asset.scan" ? evidence.trim().length > 0 : method === "asset.rights.update" ? Boolean(rightsStatus && rightsScope) : method === "asset.facts.confirm" ? factsJson.trim().length > 0 && reason.trim().length >= 4 : false;
  const submit = async () => {
    if (!target || !canSubmit) return;
    setSubmitting(true);
    const saved = await governUploadedAsset(target, { evidence, rightsStatus, rightsScope, factsJson, reason });
    setSubmitting(false);
    if (saved) close();
  };

  return (
    <Card title="上传素材治理动作" size="small">
      <Table
        rowKey="id"
        pagination={{ pageSize: 6 }}
        dataSource={marketingQueue.uploadedAssetRisks}
        columns={[
          { title: "素材", dataIndex: "name" },
          {
            title: "安全/解析/权益",
            render: (_: unknown, row: UploadedAssetRisk) =>
              `${row.scanStatus} / ${row.parseStatus} / ${row.rightsStatus}`,
          },
          {
            title: "就绪状态",
            dataIndex: "readiness.status",
            render: (_: unknown, row: UploadedAssetRisk) => (
              <Tag
                color={row.readiness.status === "ready" ? "green" : "orange"}
              >
                {row.readiness.status}
              </Tag>
            ),
          },
          {
            title: "下一步",
            render: (_: unknown, row: UploadedAssetRisk) =>
              row.nextAction?.label ?? row.nextStep ?? "-",
          },
          {
            title: "操作",
            render: (_: unknown, row: UploadedAssetRisk) => (
              <Button
                type="link"
                disabled={!canKnowledge || !row.nextAction}
                onClick={() => open(row)}
              >
                执行治理动作
              </Button>
            ),
          },
        ]}
      />
      <Modal title={`执行素材治理 · ${target?.name ?? ""}`} open={Boolean(target)} okText="提交治理动作" cancelText="取消" confirmLoading={submitting} okButtonProps={{ disabled: !canSubmit }} onCancel={close} onOk={() => void submit()}>
        <Typography.Paragraph>该操作会调用真实治理接口并写入审计；未提交前不会改变素材状态。</Typography.Paragraph>
        {method === "asset.scan" && <><label htmlFor="asset-scan-evidence">安全扫描证据引用</label><Input id="asset-scan-evidence" autoFocus maxLength={300} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="例如 scan://report-123" /></>}
        {method === "asset.rights.update" && <Space direction="vertical" style={{ width: "100%" }}>
          <label htmlFor="asset-rights-status">权益状态</label><Select id="asset-rights-status" value={rightsStatus} onChange={setRightsStatus} options={[{ value: "approved", label: "已批准" }, { value: "rejected", label: "已拒绝" }, { value: "pending", label: "待确认" }]} />
          <label htmlFor="asset-rights-scope">权益范围</label><Select id="asset-rights-scope" value={rightsScope} onChange={setRightsScope} options={[{ value: "owned", label: "自有" }, { value: "commercial_authorized", label: "商业授权" }, { value: "limited_use", label: "限制使用" }, { value: "internal_only", label: "仅内部" }, { value: "unknown", label: "未知" }, { value: "unusable", label: "不可用" }]} />
        </Space>}
        {method === "asset.facts.confirm" && <Space direction="vertical" style={{ width: "100%" }}>
          <label htmlFor="asset-facts-json">人工确认事实 JSON</label><Input.TextArea id="asset-facts-json" autoFocus rows={5} value={factsJson} onChange={(event) => setFactsJson(event.target.value)} placeholder='{"material":"待确认"}' />
          <label htmlFor="asset-facts-reason">确认原因（至少 4 个字符）</label><Input.TextArea id="asset-facts-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Space>}
        {!method && <Typography.Text type="secondary">当前素材没有可执行的服务端治理动作。</Typography.Text>}
      </Modal>
    </Card>
  );
}
