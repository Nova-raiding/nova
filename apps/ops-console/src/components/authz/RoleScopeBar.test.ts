import { describe, expect, it } from "vitest";
import type { OperationalAlert } from "../../types/ops.js";
import { notificationFeed } from "./RoleScopeBar.js";

const alert = (overrides: Partial<OperationalAlert>): OperationalAlert => ({
  id: "alert_1",
  code: "PUBLISH_STALLED",
  severity: "high",
  platform: "taobao",
  entityType: "publish_batch",
  entityId: "batch_1",
  title: "发布批次卡住",
  status: "open",
  observedAt: "2026-09-19T02:00:00.000Z",
  evidence: {},
  nextAction: "人工处理",
  ...overrides,
});

describe("notificationFeed", () => {
  it("unions both sources instead of letting the empty one win", () => {
    // A platform-scoped read fills `alerts` and leaves `notifications` as the
    // `[]` the model seeded, so a `notifications ?? alerts` fallback dropped
    // every alert the badge counted.
    const feed = notificationFeed([alert({ id: "a1" })], []);
    expect(feed.map((item) => item.id)).toEqual(["a1"]);
  });

  it("keeps the alerts a workspace-scoped read fills", () => {
    expect(notificationFeed(undefined, [alert({ id: "n1" })])).toHaveLength(1);
    expect(notificationFeed(undefined, undefined)).toEqual([]);
  });

  it("de-duplicates one dataset read twice and orders newest first", () => {
    const older = alert({ id: "shared", title: "旧标题", observedAt: "2026-09-18T02:00:00.000Z" });
    const newer = alert({ id: "shared", title: "新标题", observedAt: "2026-09-19T02:00:00.000Z" });
    const feed = notificationFeed([older], [newer, alert({ id: "other", observedAt: "2026-09-17T02:00:00.000Z" })]);
    expect(feed.map((item) => item.id)).toEqual(["shared", "other"]);
    // The alert copy wins the id collision: it is applied last.
    expect(feed[0].title).toBe("旧标题");
    expect(feed[0].observedAt).toBe("2026-09-18T02:00:00.000Z");
  });
});
