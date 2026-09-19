import { describe, expect, it } from "vitest";
import type { AlertNotificationReadiness, OperationalAlert } from "../../../types/ops";
import { alertChannelNotice, alertDeliveryEvidence, alertDeliveryPresentation, alertDeliveryEvidenceNote } from "./alertNotificationPresentation.js";

const alert = (overrides: Partial<OperationalAlert> = {}): OperationalAlert => ({
  id: "alert_1",
  code: "PUBLISH_STALLED",
  severity: "high",
  entityType: "publish_batch",
  entityId: "batch_1",
  title: "发布卡住",
  status: "open",
  observedAt: "2026-09-19T02:00:00.000Z",
  evidence: {},
  nextAction: "人工处理",
  ...overrides,
});

const withNotification = (
  delivery: "delivered" | "failed" | "blocked" | "disabled",
  attempts: number,
  reason?: string,
): OperationalAlert =>
  alert({ notification: { delivery, attempts, ...(reason ? { reason } : {}), updatedAt: "2026-09-19T02:00:00.000Z" } });

/** The shape `ops.alerts.list` returns for a platform-scoped read. */
const platformGroup = (delivery: string): OperationalAlert =>
  alert({
    id: "platform-alert-group-1",
    entityType: "platform_alert_group",
    entityId: "redacted",
    title: "3 条平台告警（PUBLISH_STALLED）",
    evidence: { scope: "platform", count: 3, notification_delivery: delivery },
  });

const readiness = (overrides: Partial<AlertNotificationReadiness> = {}): AlertNotificationReadiness => ({
  enabled: true,
  configured: false,
  ready: false,
  reason: "OPS_ALERT_WEBHOOK_URL 未配置",
  ...overrides,
});

describe("alert delivery presentation", () => {
  it("reads the platform aggregate's evidence, not only the workspace notification record", () => {
    // Platform rows are grouped by the API and carry no `notification` at all:
    // the delivery outcome lives in evidence.notification_delivery. Ignoring it
    // rendered a recorded failure as 「待记录」, identical to an alert that was
    // never attempted — the one distinction the channel's health depends on.
    const failed = platformGroup("failed");
    expect(alertDeliveryEvidence(failed)).toEqual({ delivery: "failed" });
    expect(alertDeliveryPresentation(failed).label).toBe("投递失败");
    expect(alertDeliveryPresentation(failed).color).toBe("red");
  });

  it("never renders a recorded delivery outcome as unrecorded", () => {
    for (const delivery of ["delivered", "failed", "blocked", "disabled"] as const) {
      expect(alertDeliveryPresentation(platformGroup(delivery)).state).toBe(delivery);
    }
  });

  it("separates an alert that was never attempted from a deliberately closed channel", () => {
    const neverAttempted = alertDeliveryPresentation(alert());
    const channelClosed = alertDeliveryPresentation(withNotification("disabled", 0));
    expect(neverAttempted.state).toBe("unrecorded");
    expect(neverAttempted.label).toBe("从未投递");
    expect(channelClosed.label).toBe("通知已关闭");
    // Same neutral tag before the fix: an operator could not tell "no delivery
    // record exists" from "notification is intentionally off".
    expect(neverAttempted.color).not.toBe(channelClosed.color);
  });

  it("marks a configuration-blocked delivery apart from both", () => {
    const blocked = alertDeliveryPresentation(withNotification("blocked", 0, "OPS_ALERT_WEBHOOK_URL 未配置"));
    expect(blocked.state).toBe("blocked");
    expect(blocked.color).toBe("orange");
    expect(blocked.label).toContain("被阻断");
    expect(blocked.label).toContain("配置缺失");
    expect(blocked.detail).toContain("OPS_ALERT_WEBHOOK_URL 未配置");
    expect(blocked.detail).toContain("没有产生任何外部通知");
  });

  it("states the attempt count only where an attempt is the fact", () => {
    expect(alertDeliveryPresentation(withNotification("failed", 3)).label).toBe("投递失败 · 已尝试 3 次");
    expect(alertDeliveryPresentation(withNotification("delivered", 1)).label).toBe("已投递 · 已尝试 1 次");
    // blocked/disabled never reached the network; "0 次" beside them is noise.
    expect(alertDeliveryPresentation(withNotification("blocked", 0)).label).not.toContain("次");
    expect(alertDeliveryPresentation(withNotification("disabled", 0)).label).not.toContain("次");
  });

  it("treats a missing or unrecognized delivery record as never delivered", () => {
    expect(alertDeliveryEvidence(alert()).delivery).toBe("unrecorded");
    expect(alertDeliveryEvidence(alert({ evidence: { notification_delivery: "banana" } })).delivery).toBe("unrecorded");
  });
});

describe("alert channel notice", () => {
  it("says the channel will send nothing when the server reports it is not configured", () => {
    const notice = alertChannelNotice(readiness(), [alert()]);
    expect(notice?.tone).toBe("warning");
    expect(notice?.title).toBe("告警通道未配置");
    expect(notice?.description).toContain("当前不会有任何外部通知");
    expect(notice?.description).toContain("OPS_ALERT_WEBHOOK_URL 未配置");
    expect(notice?.description).toContain("告警只写入运营台");
  });

  it("reports a deliberately disabled channel as off rather than broken", () => {
    const notice = alertChannelNotice(readiness({ enabled: false, ready: true, reason: undefined }), []);
    expect(notice?.title).toBe("告警通知已关闭");
    expect(notice?.description).toContain("当前不会有任何外部通知");
  });

  it("stays silent only when the server confirms the channel is ready and delivery worked", () => {
    expect(alertChannelNotice(readiness({ configured: true, ready: true, reason: undefined }), [withNotification("delivered", 1)])).toBeUndefined();
  });

  it("infers an unconfigured channel from the rows when no readiness report was loaded", () => {
    // The platform workbench never requests workspace.health, so the console
    // has no readiness report there. Every alert recording blocked/disabled is
    // still proof that no external notification was produced.
    const notice = alertChannelNotice(undefined, [withNotification("blocked", 0, "OPS_ALERT_WEBHOOK_URL 未配置"), platformGroup("blocked")]);
    expect(notice?.title).toBe("告警通道未配置");
    expect(notice?.description).toContain("OPS_ALERT_WEBHOOK_URL 未配置");
  });

  it("does not claim a verdict the loaded rows cannot support", () => {
    expect(alertChannelNotice(undefined, [])).toBeUndefined();
    expect(alertChannelNotice(undefined, [withNotification("delivered", 1), withNotification("blocked", 0)])).toBeUndefined();
  });

  it("warns when the channel is configured but deliveries are failing", () => {
    const notice = alertChannelNotice(readiness({ configured: true, ready: true, reason: undefined }), [withNotification("failed", 3, "告警 Webhook 返回 HTTP 500")]);
    expect(notice?.title).toBe("告警投递失败（1 条）");
    expect(notice?.description).toContain("告警 Webhook 返回 HTTP 500");
    expect(notice?.description).toContain("通道已配置但投递失败");
  });

  it("warns when an alert has no delivery record at all", () => {
    const notice = alertChannelNotice(readiness({ configured: true, ready: true, reason: undefined }), [alert(), alert({ id: "alert_2" })]);
    expect(notice?.title).toBe("告警从未投递（2 条）");
    expect(notice?.description).toContain("没有投递记录");
  });

  it("states what the delivery column can and cannot prove", () => {
    expect(alertDeliveryEvidenceNote(undefined)).toContain("无法确认告警通道是否已配置");
    expect(alertDeliveryEvidenceNote(readiness())).toContain("未通过服务端就绪校验");
    expect(alertDeliveryEvidenceNote(readiness({ enabled: false }))).toContain("告警通知已关闭");
    expect(alertDeliveryEvidenceNote(readiness({ configured: true, ready: true, reason: undefined }))).toContain("已通过服务端就绪校验");
  });
});
