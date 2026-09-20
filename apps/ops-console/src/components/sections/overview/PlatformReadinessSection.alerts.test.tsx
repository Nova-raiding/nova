import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { AlertNotificationReadiness, OperationalAlert } from "../../../types/ops";
import { PlatformReadinessSection, alertCountPresentation } from "./PlatformReadinessSection.js";

const alert = (overrides: Partial<OperationalAlert>): OperationalAlert => ({
  id: "alert_1",
  code: "PUBLISH_STALLED",
  severity: "high",
  platform: "taobao",
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
  id: string,
  delivery: "delivered" | "failed" | "blocked" | "disabled",
  attempts: number,
  reason?: string,
): OperationalAlert =>
  alert({
    id,
    notification: { delivery, attempts, ...(reason ? { reason } : {}), updatedAt: "2026-09-19T02:00:00.000Z" },
  });

/** Exactly the shape `ops.alerts.list` returns for a platform-scoped read. */
const platformGroup = (id: string, delivery: string): OperationalAlert =>
  alert({
    id,
    entityType: "platform_alert_group",
    entityId: "redacted",
    title: "3 条平台告警（PUBLISH_STALLED）",
    evidence: { scope: "platform", count: 3, notification_delivery: delivery },
  });

const model = (
  alerts: OperationalAlert[],
  alertNotificationReadiness?: AlertNotificationReadiness,
) =>
  ({
    alerts,
    alertNotificationReadiness,
    platformOperations: [],
    platformHealth: {},
    canAuditExport: false,
    exportOperations: async () => undefined,
    acknowledgeAlert: async () => undefined,
    refreshAlerts: async () => true,
    dataSetError: () => undefined,
    load: async () => undefined,
  }) as unknown as OpsConsoleModel;

const render = (alerts: OperationalAlert[], readiness?: AlertNotificationReadiness) =>
  renderToStaticMarkup(<PlatformReadinessSection model={model(alerts, readiness)} />);

/** The 通知 tag of one row, located by the table's own row key. */
const deliveryTag = (html: string, alertId: string) => {
  const start = html.indexOf(`data-row-key="${alertId}"`);
  expect(start, `row ${alertId} is missing from the alert table`).toBeGreaterThan(-1);
  const row = html.slice(start, html.indexOf("</tr>", start));
  // The tag's `title` tooltip renders before `class`, so the pattern must not
  // anchor on `class` being the first attribute.
  const tags = [...row.matchAll(/<span[^>]*class="ant-tag[^"]*"[^>]*>([^<]*)<\/span>/gu)];
  expect(tags.length, `row ${alertId} rendered no tag`).toBeGreaterThan(0);
  return tags.at(-1)![0].replace(/\s+/gu, " ");
};

const tagColor = (markup: string) => markup.match(/ant-tag-(green|red|orange|default)/u)?.[1];
const tagLabel = (markup: string) => markup.match(/>([^<]*)<\/span>$/u)?.[1];

const ready = (overrides: Partial<AlertNotificationReadiness> = {}): AlertNotificationReadiness => ({
  enabled: true,
  configured: true,
  ready: true,
  ...overrides,
});

describe("alert panel delivery column", () => {
  it("renders each delivery outcome distinguishably, including the platform aggregate rows", () => {
    const html = render([
      withNotification("a1", "delivered", 1),
      withNotification("a2", "failed", 3, "告警 Webhook 返回 HTTP 500"),
      withNotification("a3", "blocked", 0, "OPS_ALERT_WEBHOOK_URL 未配置"),
      withNotification("a4", "disabled", 0),
      alert({ id: "a5" }),
      platformGroup("a6", "failed"),
      platformGroup("a7", "unrecorded"),
    ]);
    expect(tagLabel(deliveryTag(html, "a1"))).toBe("已投递 · 已尝试 1 次");
    expect(tagColor(deliveryTag(html, "a1"))).toBe("green");
    expect(tagLabel(deliveryTag(html, "a2"))).toBe("投递失败 · 已尝试 3 次");
    expect(tagColor(deliveryTag(html, "a2"))).toBe("red");
    expect(tagLabel(deliveryTag(html, "a3"))).toBe("被阻断（配置缺失）");
    expect(tagColor(deliveryTag(html, "a3"))).toBe("orange");
    expect(tagLabel(deliveryTag(html, "a4"))).toBe("通知已关闭");
    expect(tagColor(deliveryTag(html, "a4"))).toBe("default");
    expect(tagLabel(deliveryTag(html, "a5"))).toBe("从未投递");
    // The regression: a platform row the API had already recorded as failed
    // must not read the same as the row with no delivery record at all.
    expect(tagLabel(deliveryTag(html, "a6"))).toBe("投递失败");
    expect(tagColor(deliveryTag(html, "a6"))).toBe("red");
    // a6 is the broken-channel verdict (the API recorded a failed attempt);
    // a7 is the unknown verdict (no record exists at all). Both mean "nobody
    // was paged", so both are red — the operator's question "is the channel
    // broken?" is answered by the text and by the channel notice, not by hue.
    expect(tagLabel(deliveryTag(html, "a7"))).toBe("从未投递");
    expect(tagLabel(deliveryTag(html, "a7"))).not.toBe(tagLabel(deliveryTag(html, "a6")));
  });

  it("shows the failure reason so the operator can tell what broke", () => {
    const html = render([withNotification("a2", "failed", 3, "告警 Webhook 返回 HTTP 500")]);
    expect(deliveryTag(html, "a2")).toContain("告警 Webhook 返回 HTTP 500");
    expect(deliveryTag(html, "a2")).toContain("通道可能已损坏");
  });
});

describe("alert panel channel notice", () => {
  it("states plainly that an unconfigured channel will produce no external notification", () => {
    const html = render([withNotification("a1", "blocked", 0, "OPS_ALERT_WEBHOOK_URL 未配置")], {
      enabled: true,
      configured: false,
      ready: false,
      reason: "OPS_ALERT_WEBHOOK_URL 未配置",
    });
    expect(html).toContain("告警通道未配置");
    expect(html).toContain("当前不会有任何外部通知");
    expect(html).toContain("OPS_ALERT_WEBHOOK_URL 未配置");
  });

  it("still warns when the platform view carries no readiness report", () => {
    const html = render([platformGroup("a1", "blocked"), platformGroup("a2", "blocked")]);
    expect(html).toContain("告警通道未配置");
    expect(html).toContain("当前不会有任何外部通知");
  });

  it("reports a closed notification switch as closed, not as broken", () => {
    const html = render([withNotification("a1", "disabled", 0)], { enabled: false, configured: false, ready: true });
    expect(html).toContain("告警通知已关闭");
    expect(html).toContain("当前不会有任何外部通知");
  });

  it("does not warn when the server confirms a ready channel that delivered", () => {
    const html = render([withNotification("a1", "delivered", 1)], ready());
    expect(html).not.toContain("告警通道未配置");
    expect(html).not.toContain("当前不会有任何外部通知");
    expect(html).toContain("告警通道已通过服务端就绪校验");
  });
});

describe("alert panel freshness and empty state", () => {
  it("shows when the list was last read and that it refreshes on its own", () => {
    const html = render([withNotification("a1", "delivered", 1)], ready());
    // Without a visible stamp an operator cannot separate "no alert" from
    // "this tab stopped reading an hour ago".
    expect(html).toContain("上次刷新");
    expect(html).toContain("尚未刷新");
    expect(html).toContain("每 60 秒自动刷新一次");
    expect(html).toContain("切回本标签页时立即刷新");
  });

  it("prints the read time of the rows actually on screen", () => {
    const loadedAt = new Date(2026, 8, 19, 2, 5, 7);
    const withLoadTime = {
      ...model([withNotification("a1", "delivered", 1)], ready()),
      alertsLoadedAt: loadedAt,
    } as unknown as OpsConsoleModel;
    const html = renderToStaticMarkup(<PlatformReadinessSection model={withLoadTime} />);
    expect(html).toContain("上次刷新：02:05:07");
  });

  it("refuses to let an empty list read as an all-clear", () => {
    const html = render([], ready());
    expect(html).toContain("空列表不代表没有告警");
  });

  it("surfaces a failed alert read through the shared error presentation", () => {
    const errored = {
      ...model([], ready()),
      dataSetError: (method: string) => (method === "ops.alerts.list" ? "告警数据集读取失败" : undefined),
    } as unknown as OpsConsoleModel;
    const html = renderToStaticMarkup(<PlatformReadinessSection model={errored} />);
    expect(html).toContain("告警数据集读取失败");
  });
});

/** The unacknowledged-count tag itself, located by the label it renders. */
const countTag = (html: string) =>
  html.match(/<span[^>]*class="ant-tag[^"]*"[^>]*>(未确认数未知（读取失败）|未确认数读取中|\d+ 条未确认)<\/span>/u)?.[0];

const withLoadTime = (alerts: OperationalAlert[]) =>
  ({ ...model(alerts, ready()), alertsLoadedAt: new Date(2026, 8, 19, 2, 5, 7) }) as unknown as OpsConsoleModel;

describe("alert panel unacknowledged count", () => {
  it("does not answer an unread list with a measured zero", () => {
    // `alerts` starts as `[]` and is only replaced by a successful read, so a
    // green 「0 条未确认」 over it claimed an all-clear nobody measured.
    const html = render([], ready());
    const tag = countTag(html);
    expect(tag, "the unacknowledged-count tag is missing").toBeTruthy();
    expect(tagLabel(tag!)).toBe("未确认数读取中");
    expect(tagColor(tag!)).toBe("default");
    expect(html).not.toContain("0 条未确认");
  });

  it("does not answer a failed list with a measured zero", () => {
    const errored = {
      ...model([], ready()),
      dataSetError: (method: string) => (method === "ops.alerts.list" ? "告警数据集读取失败" : undefined),
    } as unknown as OpsConsoleModel;
    const html = renderToStaticMarkup(<PlatformReadinessSection model={errored} />);
    const tag = countTag(html);
    expect(tag, "the unacknowledged-count tag is missing").toBeTruthy();
    expect(tagLabel(tag!)).toBe("未确认数未知（读取失败）");
    expect(tagColor(tag!)).toBe("red");
    expect(html).not.toContain("0 条未确认");
    // The failure is also stated in words next to the count, not by hue alone.
    expect(html).toContain("告警数据集读取失败");
  });

  it("still reports a zero that was actually read as a green all-clear", () => {
    const markup = renderToStaticMarkup(<PlatformReadinessSection model={withLoadTime([])} />);
    const tag = countTag(markup)!;
    expect(tagLabel(tag)).toBe("0 条未确认");
    expect(tagColor(tag)).toBe("green");
  });

  it("keeps counting the alerts that were read", () => {
    const markup = renderToStaticMarkup(<PlatformReadinessSection model={withLoadTime([withNotification("a1", "delivered", 1)])} />);
    const tag = countTag(markup)!;
    expect(tagLabel(tag)).toBe("1 条未确认");
    expect(tagColor(tag)).toBe("red");
  });
});

describe("alertCountPresentation", () => {
  it("ranks a recorded failure over a stale count, and an unread list over both", () => {
    expect(alertCountPresentation(3, { loadedAt: new Date(2026, 8, 19) })).toEqual({ color: "red", label: "3 条未确认" });
    expect(alertCountPresentation(0, { loadedAt: new Date(2026, 8, 19) })).toEqual({ color: "green", label: "0 条未确认" });
    expect(alertCountPresentation(0, { error: "告警数据集读取失败", loadedAt: new Date(2026, 8, 19) }))
      .toEqual({ color: "red", label: "未确认数未知（读取失败）" });
    expect(alertCountPresentation(0, {})).toEqual({ color: "default", label: "未确认数读取中" });
  });
});
