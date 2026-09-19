import type { AlertNotificationReadiness, OperationalAlert } from "../../../types/ops.js";

/**
 * Delivery states the operator must be able to tell apart at a glance.
 *
 * `unrecorded` is deliberately not a wire value. The API records four
 * outcomes, and a *missing* record is the console's evidence that no delivery
 * was ever attempted. Collapsing that into the same neutral tag as
 * `disabled` is what let a silently broken channel look like a healthy one.
 */
export const alertDeliveryStates = ["delivered", "failed", "blocked", "disabled", "unrecorded"] as const;
export type AlertDeliveryState = (typeof alertDeliveryStates)[number];

const recordedDeliveries = ["delivered", "failed", "blocked", "disabled"] as const;

export interface AlertDeliveryEvidence {
  delivery: AlertDeliveryState;
  attempts?: number;
  reason?: string;
}

/**
 * Delivery evidence for one alert row.
 *
 * Workspace-scoped rows carry `notification`. Platform-scoped rows are grouped
 * by `ops.alerts.list` and carry no `notification` at all — their delivery
 * lands in `evidence.notification_delivery`. Reading only `notification`
 * therefore rendered every platform row as 「待记录」, including rows the API had
 * already recorded as `failed`, so a broken channel and a never-attempted
 * alert were indistinguishable exactly where the alert volume is highest.
 */
export function alertDeliveryEvidence(alert: OperationalAlert): AlertDeliveryEvidence {
  const notification = alert.notification;
  if (notification) {
    return {
      delivery: notification.delivery,
      ...(typeof notification.attempts === "number" ? { attempts: notification.attempts } : {}),
      ...(typeof notification.reason === "string" && notification.reason ? { reason: notification.reason } : {}),
    };
  }
  const recorded = alert.evidence?.notification_delivery;
  const delivery = typeof recorded === "string" && (recordedDeliveries as readonly string[]).includes(recorded)
    ? (recorded as AlertDeliveryState)
    : "unrecorded";
  return { delivery };
}

export interface AlertDeliveryPresentation {
  state: AlertDeliveryState;
  color: "green" | "red" | "orange" | "default";
  label: string;
  /** Why the operator sees this state; rendered as the tag's tooltip. */
  detail: string;
}

const deliveryPresentations: Record<AlertDeliveryState, Omit<AlertDeliveryPresentation, "state">> = {
  delivered: {
    color: "green",
    label: "已投递",
    detail: "告警已由告警通道投递到外部接收端。",
  },
  failed: {
    color: "red",
    label: "投递失败",
    detail: "告警通道已尝试投递但失败；通道可能已损坏，修复前不会再产生外部通知。",
  },
  blocked: {
    color: "orange",
    label: "被阻断（配置缺失）",
    detail: "告警通道未配置或未就绪，这次告警没有产生任何外部通知，只写入了运营台。",
  },
  disabled: {
    color: "default",
    label: "通知已关闭",
    detail: "OPS_ALERT_NOTIFICATIONS_ENABLED 已关闭；告警只写入运营台，这是有意关闭而非故障。",
  },
  unrecorded: {
    color: "red",
    label: "从未投递",
    detail: "没有这条告警的投递记录，无法确认告警通道是否工作；请核对该时间段的通道配置与运行日志。",
  },
};

export function alertDeliveryPresentation(alert: OperationalAlert): AlertDeliveryPresentation {
  const evidence = alertDeliveryEvidence(alert);
  const base = deliveryPresentations[evidence.delivery];
  const attempts = (evidence.delivery === "delivered" || evidence.delivery === "failed") && evidence.attempts !== undefined
    ? ` · 已尝试 ${evidence.attempts} 次`
    : "";
  return {
    state: evidence.delivery,
    ...base,
    label: `${base.label}${attempts}`,
    detail: evidence.reason ? `${base.detail}（${evidence.reason}）` : base.detail,
  };
}

export interface AlertChannelNotice {
  tone: "warning";
  title: string;
  description: string;
}

const channelOffStates = new Set<AlertDeliveryState>(["blocked", "disabled"]);

const firstReason = (values: Array<string | undefined>): string | undefined =>
  values.find((value): value is string => typeof value === "string" && value.length > 0);

/**
 * The channel-level verdict an operator needs before trusting an empty or
 * quiet alert list: without it, "nothing was paged" and "nothing can be
 * paged" render identically.
 *
 * `readiness` is authoritative when the console loaded `workspace.health`.
 * Platform aggregation does not return it, so the rows themselves are used as
 * evidence: when every alert recorded `blocked`/`disabled`, the channel
 * provably produced no external notification for any of them.
 */
export function alertChannelNotice(
  readiness: AlertNotificationReadiness | undefined,
  alerts: readonly OperationalAlert[],
): AlertChannelNotice | undefined {
  const channelOff = readiness
    ? !readiness.enabled || !readiness.ready
    : alerts.length > 0 && alerts.every((alert) => channelOffStates.has(alertDeliveryEvidence(alert).delivery));
  if (channelOff) {
    if (readiness && !readiness.enabled) {
      return {
        tone: "warning",
        title: "告警通知已关闭",
        description: "OPS_ALERT_NOTIFICATIONS_ENABLED 已关闭：告警只写入运营台，当前不会有任何外部通知（分页、邮件、短信），必须有人打开本页面才能发现。",
      };
    }
    const reason = firstReason([
      readiness?.reason,
      ...alerts.map((alert) => alertDeliveryEvidence(alert).reason),
    ]) ?? "告警 Webhook 地址、允许主机或签名密钥缺失";
    return {
      tone: "warning",
      title: "告警通道未配置",
      description: `告警通道未就绪：${reason}。当前不会有任何外部通知（分页、邮件、短信），告警只写入运营台；请配置 OPS_ALERT_WEBHOOK_URL、OPS_ALERT_WEBHOOK_ALLOWED_HOSTS 与 OPS_ALERT_WEBHOOK_SECRET 后重试。`,
    };
  }
  const failed = alerts.filter((alert) => alertDeliveryEvidence(alert).delivery === "failed");
  if (failed.length) {
    const reason = firstReason(failed.map((alert) => alertDeliveryEvidence(alert).reason)) ?? "告警 Webhook 返回错误";
    return {
      tone: "warning",
      title: `告警投递失败（${failed.length} 条）`,
      description: `告警通道已配置但投递失败：${reason}。修复前这些告警不会出现在任何外部通知里，请核对接收端与签名密钥。`,
    };
  }
  const unrecorded = alerts.filter((alert) => alertDeliveryEvidence(alert).delivery === "unrecorded");
  if (unrecorded.length) {
    return {
      tone: "warning",
      title: `告警从未投递（${unrecorded.length} 条）`,
      description: "这些告警没有投递记录，无法确认告警通道是否工作；请核对该时间段的通道配置与运行日志，不要按「已通知」处理。",
    };
  }
  return undefined;
}

/** Where the delivery state on this page came from, and what it can and cannot prove. */
export function alertDeliveryEvidenceNote(readiness: AlertNotificationReadiness | undefined): string {
  if (!readiness) {
    return "当前视图未返回告警通道配置（平台聚合视图不携带该字段）：投递状态取自每条告警自身的投递记录，无法确认告警通道是否已配置。";
  }
  if (!readiness.enabled) return "告警通知已关闭（OPS_ALERT_NOTIFICATIONS_ENABLED 非 true）：投递状态取自每条告警自身的投递记录。";
  if (!readiness.ready) return "告警通道未通过服务端就绪校验：投递状态取自每条告警自身的投递记录。";
  return "告警通道已通过服务端就绪校验：投递状态取自每条告警自身的投递记录。";
}
