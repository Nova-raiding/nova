import type {
  ModelUsageSettlementDecision,
  ModelUsageSettlementRecord,
  ModelUsageSettlementStatus,
} from "../../types/ops.js";

export const settlementPresentation: Record<
  ModelUsageSettlementStatus,
  { label: string; color: string; nextAction: string }
> = {
  pending_cost: {
    label: "待补实际成本",
    color: "gold",
    nextAction: "按 Provider Request ID 补取中转站实际成本，再执行幂等结算。",
  },
  pending_wallet: {
    label: "等待钱包结算",
    color: "blue",
    nextAction: "重试钱包结算；不要重复调用模型或重复扣款。",
  },
  manual_attention: {
    label: "需要人工处理",
    color: "red",
    nextAction: "核对成本、扣款和审计证据后，仅执行服务端允许的人工动作。",
  },
  settled: {
    label: "已结算",
    color: "green",
    nextAction: "无需操作。",
  },
  waived: {
    label: "已豁免",
    color: "default",
    nextAction: "已由人工留痕豁免，无需再次结算。",
  },
};

export function modelUsageSettlementStatus(
  record: ModelUsageSettlementRecord,
): ModelUsageSettlementStatus {
  if (record.settlement_status) return record.settlement_status;
  const reason = `${record.settlement_reason ?? ""} ${record.last_error?.code ?? ""}`.toLowerCase();
  if (reason.includes("manual") || reason.includes("attention"))
    return "manual_attention";
  if (reason.includes("wallet")) return "pending_wallet";
  return "pending_cost";
}

export function summarizeModelUsageSettlements(
  records: ModelUsageSettlementRecord[],
) {
  const counts = {
    pending_cost: 0,
    pending_wallet: 0,
    manual_attention: 0,
  };
  for (const record of records) {
    const status = modelUsageSettlementStatus(record);
    if (status in counts) counts[status as keyof typeof counts] += 1;
  }
  return counts;
}

export function settlementActions(record: ModelUsageSettlementRecord) {
  const allowed = new Set<ModelUsageSettlementDecision>(record.allowed_decisions ?? []);
  return {
    retry: allowed.has("retry"),
    waive: allowed.has("waive"),
    manualAttention: allowed.has("manual_attention"),
  };
}
