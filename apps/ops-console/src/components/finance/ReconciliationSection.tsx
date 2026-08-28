import {
  Alert,
  Button,
  Card,
  Col,
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
import type { ModelUsageSettlementRecord } from "../../types/ops";
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
  const { reconciliation, canFinance, runReconciliation, runModelUsageReconciliation, retryModelUsageSettlement, waiveModelUsageSettlement, exportBilling } = model;
  const [settlementAction, setSettlementAction] = useState<string>();
  const [settlementFeedback, setSettlementFeedback] = useState<{
    type: "success" | "error";
    message: string;
  }>();
  const unsettled = reconciliation?.model_usage?.unsettled ?? [];
  const settlementCounts = summarizeModelUsageSettlements(unsettled);
  const disabledActionReason = (
    action: "retry" | "waive",
    statusAllowed: boolean,
    callbackAvailable: boolean,
  ) => {
    if (!canFinance) return "当前账号没有财务结算权限。";
    if (!statusAllowed)
      return action === "retry"
        ? "当前结算状态不能重试。"
        : "只有需要人工处理的记录才能申请豁免。";
    if (!callbackAvailable) return "模型结算操作暂不可用。";
    return undefined;
  };

  const runSettlementAction = async (
    action: "retry" | "waive",
    record: ModelUsageSettlementRecord,
  ) => {
    const callback =
      action === "retry"
        ? retryModelUsageSettlement
        : waiveModelUsageSettlement;
    if (!callback) return;
    if (
      action === "waive" &&
      !window.confirm(
        "确认豁免该笔模型用量？豁免必须已完成人工核对，并由后端保留原因和证据。",
      )
    )
      return;
    const actionKey = `${action}:${record.id}`;
    setSettlementAction(actionKey);
    setSettlementFeedback(undefined);
    try {
      await callback(record);
      setSettlementFeedback({
        type: "success",
        message:
          action === "retry"
            ? "结算重试已提交，列表将在后端确认后刷新。"
            : "豁免已提交并等待后端审计结果。",
      });
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
            disabled={!canFinance || !reconciliation?.provider?.ready}
            onClick={() => void runReconciliation()}
          >
            运行支付查单
          </Button>
          <Button size="small" disabled={!canFinance} onClick={() => void runModelUsageReconciliation()}>
            重试模型结算
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => void exportBilling()}
          >
            导出账单
          </Button>
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
            width: 180,
            render: (_value, record: ModelUsageSettlementRecord) => {
              const status = modelUsageSettlementStatus(record);
              const available = settlementActions(status);
              const retryAvailable = Boolean(retryModelUsageSettlement);
              const waiveAvailable = Boolean(waiveModelUsageSettlement);
              const retryDisabled = !canFinance || !available.retry || !retryAvailable;
              const waiveDisabled = !canFinance || !available.waive || !waiveAvailable;
              const retryDisabledReason = disabledActionReason("retry", available.retry, retryAvailable);
              const waiveDisabledReason = disabledActionReason("waive", available.waive, waiveAvailable);
              return (
                <Space wrap>
                  <Tooltip title={retryDisabled ? retryDisabledReason : "幂等重试当前结算步骤"}>
                    <span>
                      <Button
                        size="small"
                        disabled={retryDisabled}
                        loading={settlementAction === `retry:${record.id}`}
                        aria-label={`重试模型用量结算 ${record.id}`}
                        onClick={() => void runSettlementAction("retry", record)}
                      >
                        重试
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title={waiveDisabled ? waiveDisabledReason : "人工核对后留痕豁免"}>
                    <span>
                      <Button
                        size="small"
                        danger
                        disabled={waiveDisabled}
                        loading={settlementAction === `waive:${record.id}`}
                        aria-label={`豁免模型用量结算 ${record.id}`}
                        onClick={() => void runSettlementAction("waive", record)}
                      >
                        豁免
                      </Button>
                    </span>
                  </Tooltip>
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
