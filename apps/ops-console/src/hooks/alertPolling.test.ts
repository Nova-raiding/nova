import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_POLL_INTERVAL_MS, createAlertPoller, formatAlertRefreshedAt, latestRefreshAt } from "./alertPolling.js";

const clock = (start = Date.parse("2026-09-19T02:00:00.000Z")) => {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms; },
  };
};

describe("alert poller", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("re-reads the alert list on its own so an already-open tab discovers a new incident", async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const onRefreshed = vi.fn();
    const time = clock();
    const poller = createAlertPoller({ poll, onRefreshed, now: time.now });
    poller.start();
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("polls slower than the console's existing timers", () => {
    // A release stalls for far longer than a minute; hammering the platform
    // aggregate every few seconds would cost API budget for no extra signal.
    expect(ALERT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("does not spend API budget on a hidden tab", async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    let visible = true;
    const poller = createAlertPoller({ poll, onRefreshed: vi.fn(), isVisible: () => visible });
    poller.start();
    visible = false;
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS * 3);
    expect(poll).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("never overlaps two alert reads", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const poll = vi.fn().mockReturnValue(pending);
    const poller = createAlertPoller({ poll, onRefreshed: vi.fn() });
    poller.start();
    const first = poller.refresh();
    const second = poller.refresh();
    expect(await second).toBe(false);
    expect(poll).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(true);
    poller.stop();
  });

  it("refreshes on demand even while the tab is hidden", async () => {
    // Re-focus and the manual button must read immediately rather than wait a
    // full interval, so this path deliberately ignores the visibility gate.
    const poll = vi.fn().mockResolvedValue(undefined);
    const onRefreshed = vi.fn();
    const poller = createAlertPoller({ poll, onRefreshed, isVisible: () => false });
    poller.start();
    expect(await poller.refresh()).toBe(true);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("keeps the last successful stamp when a refresh fails", async () => {
    const onRefreshed = vi.fn();
    const onError = vi.fn();
    const poll = vi.fn().mockRejectedValue(new Error("offline"));
    const poller = createAlertPoller({ poll, onRefreshed, onError });
    poller.start();
    expect(await poller.refresh()).toBe(false);
    // A failed read must not advance the stamp: the panel's whole point is to
    // state how old the data on screen is.
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onRefreshed).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(onRefreshed).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("stops polling when the panel unmounts", async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const poller = createAlertPoller({ poll, onRefreshed: vi.fn() });
    poller.start();
    expect(poller.running()).toBe(true);
    poller.stop();
    expect(poller.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS * 3);
    expect(poll).not.toHaveBeenCalled();
  });
});

describe("alert refresh stamp", () => {
  it("states that nothing has been read yet instead of showing 00:00:00", () => {
    expect(formatAlertRefreshedAt(undefined)).toBe("尚未刷新");
  });

  it("renders a stable zero-padded local clock", () => {
    expect(formatAlertRefreshedAt(new Date(2026, 8, 19, 2, 5, 7))).toBe("02:05:07");
  });

  it("stamps the newest read, whichever source produced it", () => {
    // The full console load and the alert poll both read this dataset. Stamping
    // only the poll would print "尚未刷新" beside rows a load just refreshed.
    const fromLoad = new Date(2026, 8, 19, 2, 0, 0);
    const fromPoll = new Date(2026, 8, 19, 2, 1, 0);
    expect(formatAlertRefreshedAt(latestRefreshAt(fromLoad, fromPoll))).toBe("02:01:00");
    expect(formatAlertRefreshedAt(latestRefreshAt(fromPoll, fromLoad))).toBe("02:01:00");
    expect(formatAlertRefreshedAt(latestRefreshAt(fromLoad, undefined))).toBe("02:00:00");
    expect(formatAlertRefreshedAt(latestRefreshAt(undefined, fromPoll))).toBe("02:01:00");
    expect(latestRefreshAt(undefined, undefined)).toBeUndefined();
  });
});
