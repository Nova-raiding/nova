import { Alert, App, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { describeOpsError, rpc } from "../../../api/opsClient.js";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { UploadedAssetRisk } from "../../../types/ops";
import {
  assetScanRecoveryEvidence,
  assetScanRetryParams,
  createAssetScanRetryKey,
  parseAssetScanRetryResult,
  type AssetScanRecoveryEvidence,
} from "./assetScanRecovery.js";

interface UploadedAssetGovernanceProps {
  model: OpsConsoleModel;
}

export function UploadedAssetGovernance({
  model,
}: UploadedAssetGovernanceProps) {
  const { message } = App.useApp();
  const { canKnowledge, canQueue, governUploadedAsset, load, marketingQueue } = model;
  const [target, setTarget] = useState<UploadedAssetRisk>();
  const [rightsStatus, setRightsStatus] = useState("approved");
  const [rightsScope, setRightsScope] = useState("commercial_authorized");
  const [factsJson, setFactsJson] = useState("{}");
  const [reason, setReason] = useState("运营审核补录");
  const [submitting, setSubmitting] = useState(false);
  const [scanRetryTarget, setScanRetryTarget] = useState<{ asset: UploadedAssetRisk; evidence: AssetScanRecoveryEvidence; idempotencyKey: string }>();
  const [scanRetryReason, setScanRetryReason] = useState("");
  const [scanRetryReasonTouched, setScanRetryReasonTouched] = useState(false);
  const [scanRetrySubmitting, setScanRetrySubmitting] = useState(false);
  const [scanRetryError, setScanRetryError] = useState("");
  const [queuedEventId, setQueuedEventId] = useState("");
  const scanRetryLockRef = useRef(false);
  const scanRetryErrorRef = useRef<HTMLDivElement>(null);
  const scanRetryResultRef = useRef<HTMLDivElement>(null);
  const close = () => { if (!submitting) { setTarget(undefined); setFactsJson("{}"); setReason(""); } };
  const open = (row: UploadedAssetRisk) => { setTarget(row); setRightsStatus("approved"); setRightsScope("commercial_authorized"); setFactsJson("{}"); setReason("运营审核补录"); };
  const method = target?.nextAction?.method;
  const canSubmit = method === "asset.rights.update" ? Boolean(rightsStatus && rightsScope) : method === "asset.facts.confirm" ? factsJson.trim().length > 0 && reason.trim().length >= 4 : false;
  const submit = async () => {
    if (!target || !canSubmit) return;
    setSubmitting(true);
    const saved = await governUploadedAsset(target, { rightsStatus, rightsScope, factsJson, reason });
    setSubmitting(false);
    if (saved) close();
  };
  const failureFor = (asset: UploadedAssetRisk) =>
    assetScanRecoveryEvidence(asset, marketingQueue.assetScanFailures);
  const openScanRetry = (asset: UploadedAssetRisk) => {
    const evidence = failureFor(asset);
    if (!canQueue || !evidence.eligible || !evidence.assetRevision) return;
    setScanRetryTarget({
      asset,
      evidence,
      idempotencyKey: createAssetScanRetryKey(evidence.assetRevision, crypto.randomUUID()),
    });
    setScanRetryReason("");
    setScanRetryReasonTouched(false);
    setScanRetryError("");
    setQueuedEventId("");
  };
  const closeScanRetry = () => {
    if (scanRetrySubmitting) return;
    setScanRetryTarget(undefined);
    setScanRetryReason("");
    setScanRetryReasonTouched(false);
    setScanRetryError("");
    setQueuedEventId("");
  };
  const submitScanRetry = async () => {
    if (queuedEventId) {
      closeScanRetry();
      return;
    }
    if (!scanRetryTarget || scanRetryLockRef.current) return;
    if (scanRetryReason.trim().length < 3) {
      setScanRetryReasonTouched(true);
      return;
    }
    scanRetryLockRef.current = true;
    setScanRetrySubmitting(true);
    setScanRetryError("");
    try {
      const params = assetScanRetryParams({
        evidence: scanRetryTarget.evidence,
        reason: scanRetryReason,
        idempotencyKey: scanRetryTarget.idempotencyKey,
      });
      const result = parseAssetScanRetryResult(await rpc("ops.marketing.asset_scan.retry", params));
      setQueuedEventId(result.newEventId);
      message.success(`扫描已重新排队，新事件 ${result.newEventId}`);
      await load();
    } catch (cause) {
      setScanRetryError(describeOpsError(cause));
    } finally {
      scanRetryLockRef.current = false;
      setScanRetrySubmitting(false);
    }
  };

  useEffect(() => {
    if (scanRetryError) scanRetryErrorRef.current?.focus();
  }, [scanRetryError]);

  useEffect(() => {
    if (queuedEventId) scanRetryResultRef.current?.focus();
  }, [queuedEventId]);

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
              row.nextAction?.method === "asset.scan" ? "平台自动安全扫描中" : row.nextAction?.label ?? row.nextStep ?? "-",
          },
          {
            title: "扫描失败证据",
            render: (_: unknown, row: UploadedAssetRisk) => {
              const evidence = failureFor(row);
              if (!evidence.eventId) return <Typography.Text type="secondary">未返回扫描死信</Typography.Text>;
              return (
                <Space orientation="vertical" size={0}>
                  <Typography.Text code copyable>{evidence.eventId}</Typography.Text>
                  <Typography.Text type={evidence.retryable === true ? "secondary" : "danger"}>
                    {evidence.errorCode ?? "SCAN_FAILED"}{evidence.errorMessage ? ` · ${evidence.errorMessage}` : ""}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    retryable: {evidence.retryable === true ? "true" : evidence.retryable === false ? "false" : "未返回"} · revision {evidence.assetRevision ?? "未返回"}{evidence.sourceRevision ? ` · source ${evidence.sourceRevision}` : ""}
                  </Typography.Text>
                </Space>
              );
            },
          },
          {
            title: "操作",
            render: (_: unknown, row: UploadedAssetRisk) => {
              const evidence = failureFor(row);
              if (evidence.eventId) {
                if (evidence.eligible && canQueue) return (
                  <Button type="link" onClick={() => openScanRetry(row)} aria-label={`重新排队扫描素材 ${row.name}`}>
                    重新排队扫描
                  </Button>
                );
                return <Typography.Text type="secondary">{!canQueue ? "缺少队列治理权限" : evidence.unavailableReason}</Typography.Text>;
              }
              return (
                <Button
                  type="link"
                  disabled={!canKnowledge || !row.nextAction || row.nextAction.method === "asset.scan"}
                  onClick={() => open(row)}
                >
                  执行治理动作
                </Button>
              );
            },
          },
        ]}
      />
      <Modal title={`执行素材治理 · ${target?.name ?? ""}`} open={Boolean(target)} okText="提交治理动作" cancelText="取消" confirmLoading={submitting} okButtonProps={{ disabled: !canSubmit }} onCancel={close} onOk={() => void submit()}>
        <Typography.Paragraph>该操作会调用真实治理接口并写入审计；未提交前不会改变素材状态。</Typography.Paragraph>
        {method === "asset.scan" && <Typography.Paragraph type="secondary">安全扫描由平台自动执行。运营人员无需也不能填写扫描凭据；请刷新状态或查看平台扫描服务告警。</Typography.Paragraph>}
        {method === "asset.rights.update" && <Space orientation="vertical" style={{ width: "100%" }}>
          <label htmlFor="asset-rights-status">权益状态</label><Select id="asset-rights-status" value={rightsStatus} onChange={setRightsStatus} options={[{ value: "approved", label: "已批准" }, { value: "rejected", label: "已拒绝" }, { value: "pending", label: "待确认" }]} />
          <label htmlFor="asset-rights-scope">权益范围</label><Select id="asset-rights-scope" value={rightsScope} onChange={setRightsScope} options={[{ value: "owned", label: "自有" }, { value: "commercial_authorized", label: "商业授权" }, { value: "limited_use", label: "限制使用" }, { value: "internal_only", label: "仅内部" }, { value: "unknown", label: "未知" }, { value: "unusable", label: "不可用" }]} />
        </Space>}
        {method === "asset.facts.confirm" && <Space orientation="vertical" style={{ width: "100%" }}>
          <label htmlFor="asset-facts-json">人工确认事实 JSON</label><Input.TextArea id="asset-facts-json" autoFocus rows={5} value={factsJson} onChange={(event) => setFactsJson(event.target.value)} placeholder='{"material":"待确认"}' />
          <label htmlFor="asset-facts-reason">确认原因（至少 4 个字符）</label><Input.TextArea id="asset-facts-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Space>}
        {!method && <Typography.Text type="secondary">当前素材没有可执行的服务端治理动作。</Typography.Text>}
      </Modal>
      <div className="ops-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {scanRetrySubmitting ? "正在重新排队素材安全扫描" : queuedEventId ? `素材安全扫描已排队，新事件 ${queuedEventId}` : ""}
      </div>
      <Modal
        title={queuedEventId ? "扫描已重新排队" : `重新排队素材扫描 · ${scanRetryTarget?.asset.name ?? ""}`}
        open={Boolean(scanRetryTarget)}
        okText={queuedEventId ? "完成" : "确认重新排队"}
        cancelText="取消"
        confirmLoading={scanRetrySubmitting}
        okButtonProps={{ disabled: scanRetrySubmitting || (!queuedEventId && scanRetryReason.trim().length < 3) }}
        cancelButtonProps={{ disabled: scanRetrySubmitting, style: queuedEventId ? { display: "none" } : undefined }}
        closable={!scanRetrySubmitting}
        keyboard={!scanRetrySubmitting}
        mask={{ closable: !scanRetrySubmitting }}
        onCancel={closeScanRetry}
        onOk={() => void submitScanRetry()}
        destroyOnHidden
      >
        {scanRetryTarget && (
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="warning"
              showIcon
              title="这是重新排队，不是人工放行"
              description="旧失败事件与错误证据会原样保留；系统将创建一个新事件。此操作不会把素材直接标记为 clean，最终状态仍只接受平台扫描器的签名回调。"
            />
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="素材 ID"><Typography.Text code copyable>{scanRetryTarget.asset.id}</Typography.Text></Descriptions.Item>
              <Descriptions.Item label="旧 event_id"><Typography.Text code copyable>{scanRetryTarget.evidence.eventId}</Typography.Text></Descriptions.Item>
              <Descriptions.Item label="失败错误">{scanRetryTarget.evidence.errorCode ?? "SCAN_FAILED"}{scanRetryTarget.evidence.errorMessage ? ` · ${scanRetryTarget.evidence.errorMessage}` : ""}</Descriptions.Item>
              <Descriptions.Item label="可重试">{scanRetryTarget.evidence.retryable === true ? "true" : "false"}</Descriptions.Item>
              <Descriptions.Item label="expected revision">{scanRetryTarget.evidence.assetRevision}</Descriptions.Item>
            </Descriptions>
            {queuedEventId ? (
              <div ref={scanRetryResultRef} tabIndex={-1} role="status" aria-live="polite">
                <Alert
                  type="success"
                  showIcon
                  title="已进入扫描队列"
                  description={<span>新 event_id：<Typography.Text code copyable>{queuedEventId}</Typography.Text>。旧事件未被覆盖；请继续观察平台扫描回执。</span>}
                />
              </div>
            ) : (
              <Form layout="vertical">
                <Form.Item
                  label="重新排队原因"
                  required
                  extra="至少 3 个字符；原因会写入审计。请求失败时输入和幂等键都会保留，可安全重试。"
                  validateStatus={scanRetryReasonTouched && scanRetryReason.trim().length < 3 ? "error" : undefined}
                  help={scanRetryReasonTouched && scanRetryReason.trim().length < 3 ? "重新排队原因至少填写 3 个字符" : undefined}
                >
                  <Input.TextArea
                    aria-label="扫描重新排队原因"
                    aria-describedby="asset-scan-retry-reason-help"
                    autoFocus
                    rows={4}
                    maxLength={1000}
                    showCount
                    value={scanRetryReason}
                    disabled={scanRetrySubmitting}
                    placeholder="说明已核对的失败原因和恢复依据"
                    onChange={(event) => setScanRetryReason(event.target.value)}
                    onBlur={() => setScanRetryReasonTouched(true)}
                  />
                </Form.Item>
                <Typography.Text id="asset-scan-retry-reason-help" type="secondary">
                  重复点击或网络超时后再次提交会复用本次稳定幂等键，不会覆盖旧事件。
                </Typography.Text>
              </Form>
            )}
            {scanRetryError && (
              <div ref={scanRetryErrorRef} tabIndex={-1} role="alert">
                <Alert
                  type="error"
                  showIcon
                  title="重新排队失败"
                  description={`${scanRetryError}。输入已保留；请修正后使用同一幂等键重试。`}
                />
              </div>
            )}
          </Space>
        )}
      </Modal>
    </Card>
  );
}
