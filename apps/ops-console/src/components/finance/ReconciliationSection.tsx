import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useState } from "react";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { ModelUsageSettlementDecision, ModelUsageSettlementRecord } from "../../types/ops";
import {
  modelUsageSettlementStatus,
  settlementActions,
  settlementPresentation,
  summarizeModelUsageSettlements,
} from "./modelUsageSettlement";

interface ReconciliationSectionProps {
  model: OpsConsoleModel;
}

export function ReconciliationSection({ model }: ReconciliationSectionProps) {
  const { reconciliation, canPaymentReconciliation, canModelSettlement, canBillingExport, runReconciliation, runModelUsageReconciliation, retryModelUsageSettlement, waiveModelUsageSettlement, markModelUsageForManualAttention, exportBilling } = model;
  const [settlementForm] = Form.useForm<{ reason: string; evidenceRef: string }>();
  const [settlementAction, setSettlementAction] = useState<string>();
  const [settlementDialog, setSettlementDialog] = useState<{
    decision: ModelUsageSettlementDecision;
    record: ModelUsageSettlementRecord;
  }>();
  const [settlementFeedback, setSettlementFeedback] = useState<{
    type: "success" | "error";
    message: string;
  }>();
  const unsettled = reconciliation?.model_usage?.unsettled ?? [];
  const settlementCounts = summarizeModelUsageSettlements(unsettled);
  const disabledActionReason = (
    action: ModelUsageSettlementDecision,
    callbackAvailable: boolean,
  ) => {
    if (!canModelSettlement) return "当前账号没有模型结算权限。";
    if (!callbackAvailable) return "模型结算操作暂不可用。";
    return action === "retry" ? "填写原因和证据后幂等重试当前结算步骤。" : action === "waive" ? "填写核对原因和证据后留痕豁免。" : "填写原因和证据后转入人工关注。";
  };

  const openSettlementDialog = (decision: ModelUsageSettlementDecision, record: ModelUsageSettlementRecord) => {
    settlementForm.resetFields();
    setSettlementDialog({ decision, record });
  };

  const runSettlementAction = async (values: { reason: string; evidenceRef: string }) => {
    if (!settlementDialog) return;
    const { decision, record } = settlementDialog;
    const callback =
      decision === "retry"
        ? retryModelUsageSettlement
        : decision === "waive"
          ? waiveModelUsageSettlement
          : markModelUsageForManualAttention;
    if (!callback) return;
    const actionKey = `${decision}:${record.id}`;
    setSettlementAction(actionKey);
    setSettlementFeedback(undefined);
    try {
      await callback(record, values.reason.trim(), values.evidenceRef.trim());
      setSettlementFeedback({
        type: "success",
        message:
          decision === "retry"
            ? "结算重试已提交，列表将在后端确认后刷新。"
            : decision === "waive"
              ? "豁免已提交，原因和证据已进入后端审计。"
              : "记录已转入人工关注，原因和证据已保存。",
      });
      setSettlementDialog(undefined);
      settlementForm.resetFields();
    } catch (error) {
      setSettlementFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "模型用量结算操作失败，请重试。",
      });
    } finally {
      setSettlementAction(undefined);
    }
  };

  return (
    <Card
      id="ops-domain-finance"
      className="ops-section-anchor"
      title="财务流水与对账"
      extra={
        <Space>
          <Tag color="green">金额：元（两位小数）</Tag>
          <Button
            size="small"
            disabled={!canPaymentReconciliation || !reconciliation?.provider?.ready}
            onClick={() => void runReconciliation()}
          >
            运行支付查单
          </Button>
          <Button size="small" disabled={!canModelSettlement} onClick={() => void runModelUsageReconciliation()}>
            重试模型结算
          </Button>
          {canBillingExport && (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => void exportBilling()}
            >
              导出账单
            </Button>
          )}
        </Space>
      }
    >
      <Row gutter={[16, 16]} className="finance-summary">
        <Col xs={12} md={6}>
          <Statistic
            title="余额"
            value={reconciliation?.balance_cny ?? "-"}
            prefix="¥"
          />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="充值"
            value={reconciliation?.recharge_cny ?? "-"}
            prefix="¥"
          />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="消费"
            value={reconciliation?.debit_cny ?? "-"}
            prefix="¥"
          />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="退款"
            value={reconciliation?.refund_cny ?? "-"}
            prefix="¥"
          />
        </Col>
      </Row>
      <Alert
        type={reconciliation?.provider?.ready ? "success" : "warning"}
        showIcon
        title={`支付 provider：${reconciliation?.provider?.ready ? "已就绪" : reconciliation?.provider?.mode === "fixture" ? "当前为 fixture" : "未就绪"}`}
        description={
          reconciliation?.provider?.reasons?.join("、") ||
          "生产充值必须经服务端 provider 下单并等待签名回调"
        }
      />
      <Row gutter={[16, 16]} className="finance-summary">
        <Col xs={12} md={6}><Statistic title="模型调用" value={reconciliation?.model_usage?.record_count ?? "-"} /></Col>
        <Col xs={12} md={6}><Statistic title="模型 Tokens" value={reconciliation?.model_usage?.total_tokens ?? "-"} /></Col>
        <Col xs={12} md={6}><Statistic title="模型实际成本" value={reconciliation?.model_usage?.provider_cost_cny ?? "-"} prefix="¥" /></Col>
        <Col xs={12} md={6}><Statistic title="待结算记录" value={reconciliation?.model_usage?.unsettled_records ?? "-"} styles={reconciliation?.model_usage?.unsettled_records ? { content: { color: "#b91c1c" } } : undefined} /></Col>
      </Row>
      {Boolean(reconciliation?.model_usage?.unsettled_records) && (
        <>
          <Row gutter={[16, 16]} className="finance-summary" aria-label="模型待结算状态汇总">
            <Col xs={24} md={8}>
              <Statistic title="当前列表 · 待补实际成本" value={settlementCounts.pending_cost} styles={{ content: { color: "#92400e" } }} />
            </Col>
            <Col xs={24} md={8}>
              <Statistic title="当前列表 · 等待钱包结算" value={settlementCounts.pending_wallet} styles={{ content: { color: "#1d4ed8" } }} />
            </Col>
            <Col xs={24} md={8}>
              <Statistic title="当前列表 · 需要人工处理" value={settlementCounts.manual_attention} styles={{ content: { color: "#b91c1c" } }} />
            </Col>
          </Row>
          <Alert
            type={settlementCounts.manual_attention ? "error" : "warning"}
            showIcon
            title="存在模型未结算记录，禁止按已结算口径出账"
            description="待补成本需要向中转站补取实际人民币成本；等待钱包结算只能重试扣款，不能重复调用模型；人工处理必须核对证据后再重试或豁免。"
          />
        </>
      )}
      {settlementFeedback && (
        <Alert
          className="settlement-feedback"
          type={settlementFeedback.type}
          showIcon
          role="status"
          title={settlementFeedback.message}
          closable
          onClose={() => setSettlementFeedback(undefined)}
        />
      )}
      <Modal
        title={settlementDialog?.decision === "retry" ? "重试模型用量结算" : settlementDialog?.decision === "waive" ? "豁免模型用量结算" : "转入人工关注"}
        open={Boolean(settlementDialog)}
        okText="确认提交"
        cancelText="取消"
        confirmLoading={Boolean(settlementAction)}
        okButtonProps={{ danger: settlementDialog?.decision === "waive" }}
        onCancel={() => { if (!settlementAction) { setSettlementDialog(undefined); settlementForm.resetFields(); } }}
        onOk={() => settlementForm.submit()}
      >
        <Form
          form={settlementForm}
          layout="vertical"
          requiredMark
          onFinish={(values) => void runSettlementAction(values)}
          onFinishFailed={({ errorFields }) => {
            const first = errorFields[0]?.name;
            if (first) settlementForm.scrollToField(first, { block: "center", focus: true });
          }}
          aria-label="模型用量人工处理审计信息"
        >
          <Form.Item name="reason" label="处理原因" rules={[{ required: true, whitespace: true, message: "请填写本次人工处理原因" }, { min: 4, message: "处理原因至少填写 4 个字符" }]}>
            <Input.TextArea rows={3} placeholder="说明核对结果、异常原因和处理依据" autoFocus />
          </Form.Item>
          <Form.Item name="evidenceRef" label="Evidence 引用" extra="填写工单、对账记录或中转站回执的可追溯引用。" rules={[{ required: true, whitespace: true, message: "请填写可追溯的 evidence 引用" }]}>
            <Input placeholder="例如 ticket://OPS-123 或 relay://request-id" />
          </Form.Item>
        </Form>
      </Modal>
      <Table
        rowKey="id"
        size="small"
        pagination={{ pageSize: 5 }}
        locale={{ emptyText: "没有模型待结算记录" }}
        dataSource={unsettled}
        scroll={{ x: 1180 }}
        columns={[
          {
            title: "结算状态",
            key: "settlement_status",
            fixed: "left",
            width: 140,
            render: (_value, record: ModelUsageSettlementRecord) => {
              const status = modelUsageSettlementStatus(record);
              const presentation = settlementPresentation[status];
              return <Tag color={presentation.color}>{presentation.label}</Tag>;
            },
          },
          { title: "发现时间", dataIndex: "observed_at", width: 180, render: (value: string) => new Date(value).toLocaleString() },
          { title: "模态", dataIndex: "modality" },
          { title: "模型", dataIndex: "model" },
          { title: "Provider Request ID", dataIndex: "provider_request_id", width: 200, render: (value: string | null) => <Typography.Text className="ops-token" copyable={Boolean(value)}>{value || "—"}</Typography.Text> },
          {
            title: "原因与下一步",
            key: "settlement_guidance",
            width: 300,
            render: (_value, record: ModelUsageSettlementRecord) => {
              const status = modelUsageSettlementStatus(record);
              return (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{record.settlement_reason || "未提供阻断原因"}</Typography.Text>
                  <Typography.Text type="secondary">{settlementPresentation[status].nextAction}</Typography.Text>
                </Space>
              );
            },
          },
          {
            title: "操作",
            key: "actions",
            fixed: "right",
            width: 260,
            render: (_value, record: ModelUsageSettlementRecord) => {
              const available = settlementActions(record);
              const retryAvailable = Boolean(retryModelUsageSettlement);
              const waiveAvailable = Boolean(waiveModelUsageSettlement);
              const manualAttentionAvailable = Boolean(markModelUsageForManualAttention);
              const retryDisabled = !canModelSettlement || !retryAvailable;
              const waiveDisabled = !canModelSettlement || !waiveAvailable;
              const manualAttentionDisabled = !canModelSettlement || !manualAttentionAvailable;
              return (
                <Space wrap>
                  {available.retry && <Tooltip title={disabledActionReason("retry", retryAvailable)}>
                    <span>
                      <Button
                        size="small"
                        disabled={retryDisabled}
                        loading={settlementAction === `retry:${record.id}`}
                        aria-label={`重试模型用量结算 ${record.id}`}
                        onClick={() => openSettlementDialog("retry", record)}
                      >
                        重试
                      </Button>
                    </span>
                  </Tooltip>}
                  {available.waive && <Tooltip title={disabledActionReason("waive", waiveAvailable)}>
                    <span>
                      <Button
                        size="small"
                        danger
                        disabled={waiveDisabled}
                        loading={settlementAction === `waive:${record.id}`}
                        aria-label={`豁免模型用量结算 ${record.id}`}
                        onClick={() => openSettlementDialog("waive", record)}
                      >
                        豁免
                      </Button>
                    </span>
                  </Tooltip>}
                  {available.manualAttention && <Tooltip title={disabledActionReason("manual_attention", manualAttentionAvailable)}>
                    <span>
                      <Button
                        size="small"
                        disabled={manualAttentionDisabled}
                        loading={settlementAction === `manual_attention:${record.id}`}
                        aria-label={`将模型用量结算转入人工关注 ${record.id}`}
                        onClick={() => openSettlementDialog("manual_attention", record)}
                      >
                        人工关注
                      </Button>
                    </span>
                  </Tooltip>}
                  {!available.retry && !available.waive && !available.manualAttention && <Typography.Text type="secondary">暂无合法动作</Typography.Text>}
                </Space>
              );
            },
          },
        ]}
      />
      <Table
        rowKey="id"
        pagination={{ pageSize: 8 }}
        dataSource={reconciliation?.transactions ?? []}
        columns={[
          {
            title: "时间",
            dataIndex: "createdAt",
            render: (value: string) => new Date(value).toLocaleString(),
          },
          { title: "类型", dataIndex: "type" },
          {
            title: "金额",
            dataIndex: "amount_cny",
            render: (value: string) => `¥${Number(value).toFixed(2)}`,
          },
          { title: "说明", dataIndex: "description" },
        ]}
      />
    </Card>
  );
}
