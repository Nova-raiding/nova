import type { AssetScanFailure, UploadedAssetRisk } from "../../../types/ops.js";

type UnknownRecord = Record<string, unknown>;

export interface AssetScanRecoveryEvidence {
  assetId: string;
  eventId?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  assetRevision?: number;
  sourceRevision?: number;
  failedAt?: string;
  eligible: boolean;
  unavailableReason?: string;
}

const record = (value: unknown): UnknownRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const positiveInteger = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

function normalizedFailure(value: unknown): Omit<AssetScanRecoveryEvidence, "assetId" | "eligible" | "unavailableReason"> | undefined {
  const row = record(value);
  if (!row) return undefined;
  const error = record(row.error ?? row.last_error ?? row.lastError);
  return {
    eventId: text(row.eventId ?? row.event_id ?? row.outboxEventId ?? row.outbox_event_id),
    errorCode: text(row.errorCode ?? row.error_code ?? error?.code),
    errorMessage: text(row.errorMessage ?? row.error_message ?? error?.message),
    ...(typeof row.retryable === "boolean" ? { retryable: row.retryable } : {}),
    assetRevision: positiveInteger(row.assetRevision ?? row.asset_revision ?? row.expectedAssetRevision ?? row.expected_asset_revision),
    sourceRevision: positiveInteger(row.sourceRevision ?? row.source_revision ?? row.assetSourceRevision ?? row.asset_source_revision),
    failedAt: text(row.failedAt ?? row.failed_at ?? row.updatedAt ?? row.updated_at),
  };
}

export function assetScanRecoveryEvidence(
  asset: UploadedAssetRisk,
  failures: readonly AssetScanFailure[] = [],
): AssetScanRecoveryEvidence {
  const nested = normalizedFailure(
    asset.scanFailure ?? (asset as UploadedAssetRisk & { scan_failure?: unknown }).scan_failure,
  );
  const matching = failures.find((failure) => {
    const row = record(failure);
    return text(row?.assetId ?? row?.asset_id) === asset.id;
  });
  const failure = nested ?? normalizedFailure(matching);
  const assetRevision = failure?.assetRevision ?? positiveInteger(asset.revision);
  const base = {
    assetId: asset.id,
    ...failure,
    assetRevision,
  };
  if (!failure) return { ...base, eligible: false, unavailableReason: "服务端未返回可验证的扫描死信事件" };
  if (!failure.eventId) return { ...base, eligible: false, unavailableReason: "扫描失败证据缺少 event_id" };
  if (!failure.errorCode && !failure.errorMessage) return { ...base, eligible: false, unavailableReason: "扫描失败证据缺少结构化错误" };
  if (failure.retryable !== true) return { ...base, eligible: false, unavailableReason: failure.retryable === false ? "该失败不可重试" : "服务端未明确标记 retryable" };
  if (!assetRevision) return { ...base, eligible: false, unavailableReason: "素材 revision 缺失或无效" };
  return { ...base, eligible: true };
}

export function createAssetScanRetryKey(revision: number, uuid: string): string {
  const normalizedUuid = uuid.trim();
  if (!Number.isSafeInteger(revision) || revision < 1 || !/^[A-Za-z0-9._:-]+$/u.test(normalizedUuid))
    throw new Error("无法生成有效的扫描重试幂等键");
  const key = `asset-scan:retry:r${revision}:${normalizedUuid}`;
  if (key.length > 200) throw new Error("扫描重试幂等键过长");
  return key;
}

export function assetScanRetryParams(input: {
  evidence: AssetScanRecoveryEvidence;
  reason: string;
  idempotencyKey: string;
}) {
  const reason = input.reason.trim();
  if (!input.evidence.eligible || !input.evidence.eventId || !input.evidence.assetRevision)
    throw new Error(input.evidence.unavailableReason ?? "扫描失败证据不完整，禁止重新排队");
  if (reason.length < 3) throw new Error("重新排队原因至少填写 3 个字符");
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(input.idempotencyKey))
    throw new Error("扫描重试幂等键无效");
  return {
    asset_id: input.evidence.assetId,
    event_id: input.evidence.eventId,
    expected_asset_revision: String(input.evidence.assetRevision),
    idempotency_key: input.idempotencyKey,
    reason,
  };
}

export function parseAssetScanRetryResult(value: unknown): { newEventId: string; replayed: boolean } {
  const row = record(value);
  const event = record(row?.event ?? row?.newEvent ?? row?.new_event);
  const newEventId = text(row?.newEventId ?? row?.new_event_id ?? row?.eventId ?? row?.event_id ?? event?.id);
  if (!newEventId) throw new Error("扫描重试响应缺少新 event_id；请使用同一幂等键重试以核对结果");
  return {
    newEventId,
    replayed: row?.replayed === true || row?.idempotentReplay === true || row?.idempotent_replay === true,
  };
}
