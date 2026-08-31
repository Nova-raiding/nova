import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { UploadedAssetRisk } from "../../../types/ops.js";
import { assetScanRecoveryEvidence, assetScanRetryParams, createAssetScanRetryKey, parseAssetScanRetryResult } from "./assetScanRecovery.js";

const governanceSource = readFileSync(new URL("./UploadedAssetGovernance.tsx", import.meta.url), "utf8");

const asset = (patch: Partial<UploadedAssetRisk> = {}): UploadedAssetRisk => ({
  id: "asset-1",
  name: "source.png",
  mimeType: "image/png",
  scanStatus: "quarantined",
  parseStatus: "pending",
  rightsStatus: "approved",
  readiness: { status: "blocked", reasons: ["扫描失败"] },
  revision: 3,
  createdAt: "2026-08-31T00:00:00.000Z",
  ...patch,
});

describe("asset scan dead-letter recovery", () => {
  it("accepts real camelCase evidence and builds the exact MCP contract", () => {
    const evidence = assetScanRecoveryEvidence(asset({ scanFailure: { eventId: "evt-old", errorCode: "CLAMAV_UNAVAILABLE", errorMessage: "scanner unavailable", retryable: true, assetRevision: 3, sourceRevision: 1 } }));
    expect(evidence).toMatchObject({ eligible: true, eventId: "evt-old", retryable: true, assetRevision: 3, sourceRevision: 1 });
    expect(assetScanRetryParams({ evidence, reason: " 扫描服务已恢复 ", idempotencyKey: "asset-scan:retry:key-1" })).toEqual({
      asset_id: "asset-1",
      event_id: "evt-old",
      expected_asset_revision: "3",
      idempotency_key: "asset-scan:retry:key-1",
      reason: "扫描服务已恢复",
    });
  });

  it("normalizes a separate snake_case queue failure without inventing data", () => {
    const evidence = assetScanRecoveryEvidence(asset(), [{ asset_id: "asset-1", event_id: "evt-snake", error: { code: "TIMEOUT", message: "timed out" }, retryable: true, asset_revision: "3" } as never]);
    expect(evidence).toMatchObject({ eligible: true, eventId: "evt-snake", errorCode: "TIMEOUT", errorMessage: "timed out", assetRevision: 3 });
  });

  it("fails closed when event, error, retryability or revision is not verified", () => {
    expect(assetScanRecoveryEvidence(asset()).eligible).toBe(false);
    expect(assetScanRecoveryEvidence(asset({ scanFailure: { retryable: true, errorCode: "TIMEOUT" } })).unavailableReason).toContain("event_id");
    expect(assetScanRecoveryEvidence(asset({ scanFailure: { eventId: "evt", retryable: true } })).unavailableReason).toContain("结构化错误");
    expect(assetScanRecoveryEvidence(asset({ scanFailure: { eventId: "evt", errorCode: "TIMEOUT" } })).unavailableReason).toContain("retryable");
    expect(assetScanRecoveryEvidence(asset({ revision: 0, scanFailure: { eventId: "evt", errorCode: "TIMEOUT", retryable: true } })).unavailableReason).toContain("revision");
  });

  it("creates a bounded key that callers can retain across recoverable failures", () => {
    const key = createAssetScanRetryKey(3, "fixed-uuid");
    expect(key).toBe("asset-scan:retry:r3:fixed-uuid");
    expect(createAssetScanRetryKey(3, "fixed-uuid")).toBe(key);
    expect(() => createAssetScanRetryKey(0, "fixed-uuid")).toThrow();
  });

  it("requires a new event id and accepts nested repository results", () => {
    expect(parseAssetScanRetryResult({ event: { id: "evt-new" }, replayed: false })).toEqual({ newEventId: "evt-new", replayed: false });
    expect(parseAssetScanRetryResult({ new_event_id: "evt-replay", idempotent_replay: true })).toEqual({ newEventId: "evt-replay", replayed: true });
    expect(() => parseAssetScanRetryResult({ queued: true })).toThrow(/同一幂等键/u);
  });

  it("implements accessible async recovery without allowing duplicate submission or dismissal", () => {
    expect(governanceSource).toContain('rpc("ops.marketing.asset_scan.retry", params)');
    expect(governanceSource).toContain("scanRetryLockRef.current")
    expect(governanceSource).toContain('closable={!scanRetrySubmitting}')
    expect(governanceSource).toContain('keyboard={!scanRetrySubmitting}')
    expect(governanceSource).toContain('role="alert"')
    expect(governanceSource).toContain('aria-live="polite"')
    expect(governanceSource).toContain('onBlur={() => setScanRetryReasonTouched(true)}')
    expect(governanceSource).toContain("旧失败事件与错误证据会原样保留")
    expect(governanceSource).toContain("不会把素材直接标记为 clean")
  });
});
