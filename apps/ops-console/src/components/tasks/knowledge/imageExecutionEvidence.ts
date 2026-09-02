import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel.js";

export type ImageExecution = OpsConsoleModel["marketingQueue"]["imageExecutions"][number];
export type ImageEvidenceKey = "request" | "usage" | "cost" | "error";

export interface ImageExecutionEvidenceItem {
  key: ImageEvidenceKey;
  label: string;
  present: boolean;
  required: boolean;
  detail: string;
}

export interface ImageExecutionEvidenceGate {
  blocked: boolean;
  relay503: boolean;
  relayStatus: string;
  blockers: string[];
  recovery: string[];
  evidence: ImageExecutionEvidenceItem[];
}

const RECONCILEABLE_STATES = new Set(["unknown", "outcome_unknown", "manual_attention"]);

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | undefined {
  return value && typeof value === "object" ? value as LooseRecord : undefined;
}

function readString(source: LooseRecord | undefined, keys: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(source: LooseRecord | undefined, keys: readonly string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readBoolean(source: LooseRecord | undefined, keys: readonly string[]): boolean | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function hasEvidenceValue(source: LooseRecord | undefined, keys: readonly string[]): boolean {
  if (!source) return false;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean" && value) return true;
    if (typeof value === "string" && value.trim()) return true;
    if (value && typeof value === "object") return true;
  }
  return false;
}

function relayStatus(execution: ImageExecution, root: LooseRecord, relay: LooseRecord | undefined): { relay503: boolean; label: string } {
  const httpStatus = readNumber(root, ["httpStatus", "http_status", "relayHttpStatus", "relay_http_status"])
    ?? readNumber(relay, ["httpStatus", "http_status", "status", "status_code"]);
  const errorCode = execution.errorCode?.trim().toUpperCase() ?? readString(root, ["relayErrorCode", "relay_error_code"])?.toUpperCase();
  const errorMessage = execution.errorMessage?.trim() ?? readString(root, ["relayErrorMessage", "relay_error_message"]);
  const relay503 = httpStatus === 503
    || errorCode === "HTTP_503"
    || errorCode === "MODEL_PROVIDER_UNAVAILABLE"
    || /503|service unavailable|no available channel/i.test(`${errorCode ?? ""} ${errorMessage ?? ""}`);
  if (relay503) return { relay503, label: "503 Service Unavailable" };
  if (typeof httpStatus === "number") return { relay503, label: `HTTP ${httpStatus}` };
  if (errorCode && errorMessage) return { relay503, label: `${errorCode} · ${errorMessage}` };
  if (errorCode) return { relay503, label: errorCode };
  if (errorMessage) return { relay503, label: errorMessage };
  return { relay503, label: "未返回" };
}

function evidenceFlags(execution: ImageExecution, root: LooseRecord, evidence: LooseRecord | undefined) {
  const requestPresent = hasEvidenceValue(root, ["requestEvidence", "request_evidence", "requestEvidenceRef", "request_evidence_ref", "requestObserved", "request_observed", "requestEvidenceReady", "request_evidence_ready"])
    || hasEvidenceValue(evidence, ["request", "request_ref", "requestObserved", "request_observed", "requestEvidenceRef", "request_evidence_ref"]);
  const usagePresent = hasEvidenceValue(root, ["usageEvidence", "usage_evidence", "usageEvidenceRef", "usage_evidence_ref", "usageObserved", "usage_observed", "usageEvidenceReady", "usage_evidence_ready"])
    || hasEvidenceValue(evidence, ["usage", "usage_ref", "usageObserved", "usage_observed", "usageEvidenceRef", "usage_evidence_ref"]);
  const costPresent = hasEvidenceValue(root, ["costEvidence", "cost_evidence", "costEvidenceRef", "cost_evidence_ref", "costObserved", "cost_observed", "costEvidenceReady", "cost_evidence_ready"])
    || hasEvidenceValue(evidence, ["cost", "cost_ref", "costObserved", "cost_observed", "costEvidenceRef", "cost_evidence_ref"]);
  const explicitErrorEvidence = hasEvidenceValue(root, ["errorEvidence", "error_evidence", "errorEvidenceRef", "error_evidence_ref", "errorObserved", "error_observed", "errorEvidenceReady", "error_evidence_ready"])
    || hasEvidenceValue(evidence, ["error", "error_ref", "errorObserved", "error_observed", "errorEvidenceRef", "error_evidence_ref"]);
  const errorPresent = explicitErrorEvidence || Boolean(execution.errorCode?.trim() || execution.errorMessage?.trim());
  return { requestPresent, usagePresent, costPresent, errorPresent };
}

export function canReconcileImageExecution(execution: ImageExecution | undefined): boolean {
  if (!execution) return false;
  return RECONCILEABLE_STATES.has(execution.state) || execution.reconciliationStatus === "required";
}

export function summarizeImageExecutionEvidence(execution: ImageExecution): ImageExecutionEvidenceGate {
  const root = asRecord(execution) ?? {};
  const evidence = asRecord(root.evidence);
  const relay = asRecord(root.relay);
  const relaySnapshot = relayStatus(execution, root, relay);
  const flags = evidenceFlags(execution, root, evidence);
  const errorRequired = relaySnapshot.relay503
    || ["failed", "unknown", "outcome_unknown", "manual_attention"].includes(execution.state)
    || Boolean(execution.errorCode?.trim() || execution.errorMessage?.trim());

  const evidenceItems: ImageExecutionEvidenceItem[] = [
    {
      key: "request",
      label: "request evidence",
      present: flags.requestPresent,
      required: true,
      detail: flags.requestPresent ? "已返回 request evidence，可追溯到单一桌面提交。" : "未返回 request evidence，无法确认本次桌面提交与唯一 Provider 请求一一对应。",
    },
    {
      key: "usage",
      label: "usage evidence",
      present: flags.usagePresent,
      required: true,
      detail: flags.usagePresent ? "已返回 usage evidence，可核对真实用量。" : "未返回 usage evidence，无法证明本次图片生成产生了真实用量。",
    },
    {
      key: "cost",
      label: "cost evidence",
      present: flags.costPresent,
      required: true,
      detail: flags.costPresent ? "已返回 cost evidence，可核对真实成本。" : "未返回 cost evidence，无法证明本次图片生成产生了真实成本。",
    },
    {
      key: "error",
      label: "error evidence",
      present: flags.errorPresent,
      required: errorRequired,
      detail: errorRequired
        ? flags.errorPresent
          ? "已返回 error evidence，可解释失败或异常来源。"
          : "未返回 error evidence，无法解释当前失败或异常状态。"
        : "当前未要求 error evidence。",
    },
  ];

  const blockers: string[] = [];
  if (relaySnapshot.relay503) blockers.push("relay 返回 503 Service Unavailable，当前没有可用模型通道或计费组；桌面端保持阻断，禁止重复生成。");
  for (const item of evidenceItems) {
    if (item.required && !item.present) blockers.push(item.detail);
  }

  const recovery = new Set<string>();
  if (relaySnapshot.relay503) recovery.add("先排查中转站可用通道、SVIP 计费组和模型配置，再刷新任务；不要在桌面端重复生成。");
  recovery.add("导出脱敏证据包并附到工单或审计附件，保留 request / usage / cost / error 证据链。");
  if (canReconcileImageExecution(execution)) recovery.add("若服务端已确认最终结果，使用“打开人工收口”提交 evidence ref；不要创建第二个 Provider 请求。");
  else recovery.add("当前仅允许继续观测；在服务端确认终态前，不要人工补发第二个 Provider 请求。");

  return {
    blocked: blockers.length > 0,
    relay503: relaySnapshot.relay503,
    relayStatus: relaySnapshot.label,
    blockers,
    recovery: [...recovery],
    evidence: evidenceItems,
  };
}
