import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Low-frequency alert refresh.
 *
 * Alerting terminates at the receiver: there is no paging, mail or SMS, and no
 * server push. An operator tab that was opened before a release stalled at
 * 02:00 therefore keeps rendering the alert list it loaded at mount and never
 * shows the incident. A bounded poll plus a visible "last refreshed" stamp is
 * the smallest honest fix: the tab discovers a new alert on its own, and the
 * operator can tell how stale the panel is when it does not.
 *
 * 60s is intentionally slower than the console's other timers: the alert list
 * is a review surface, not a live gauge, and the platform aggregate fans out
 * across every authorized workspace.
 */
export const ALERT_POLL_INTERVAL_MS = 60_000;

/** Node returns a `Timeout` object; the DOM returns a number. */
type TimerHandle = ReturnType<typeof globalThis.setInterval>;

export interface AlertPollerOptions {
  /**
   * One read attempt. The resolved value is part of the contract, not a
   * by-product, and both sides of the call read it the same way:
   *
   * - `true`  — a read answered. The data now rendered is this attempt's, so
   *             the freshness stamp may advance.
   * - `false` — nothing was measured. The attempt declined to issue a request
   *             (no connection, missing capability, invalidated authorization
   *             generation) or the request did not answer.
   *
   * `false` must never advance a stamp or produce a count: a "last refreshed"
   * clock printed beside "0 条未确认" is a measured all-clear that nobody
   * measured, and the panel exists precisely to keep those apart.
   */
  poll: () => Promise<boolean>;
  onRefreshed: (at: Date) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  now?: () => Date;
  setTimer?: (handler: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** A hidden tab must not keep spending API budget on a list nobody reads. */
  isVisible?: () => boolean;
}

export interface AlertPoller {
  start: () => void;
  stop: () => void;
  /**
   * Runs outside the interval: used by the manual button and on re-focus.
   * Resolves `true` only when this attempt really read the dataset; `false`
   * covers "declined to read", "already in flight" and "the read failed".
   */
  refresh: () => Promise<boolean>;
  running: () => boolean;
}

export function createAlertPoller(options: AlertPollerOptions): AlertPoller {
  const intervalMs = options.intervalMs ?? ALERT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  // Keep the timer calls bound to `globalThis`: passing the host function
  // around unbound risks an "Illegal invocation" in the browser.
  const setTimer = options.setTimer ?? ((handler, ms) => globalThis.setInterval(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearInterval(handle));
  const isVisible = options.isVisible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  let handle: TimerHandle | undefined;
  let inFlight = false;

  const run = async (): Promise<boolean> => {
    // A slow aggregate read must not queue a second request behind itself.
    if (inFlight) return false;
    inFlight = true;
    try {
      const read = await options.poll();
      // `poll()` answers whether it read, and the stamp follows that answer —
      // not the mere fact that the promise settled. A poll that returned early
      // (no connection, missing capability, invalidated generation) settles
      // successfully without having measured anything, and stamping it turned
      // 「未确认数读取中」 into a green 「0 条未确认」 over a request that was
      // never sent.
      if (!read) return false;
      options.onRefreshed(now());
      return true;
    } catch (error) {
      // Keep the last successful stamp: the panel states its own staleness
      // rather than pretending a failed refresh produced fresh data.
      options.onError?.(error);
      return false;
    } finally {
      inFlight = false;
    }
  };

  return {
    start: () => {
      if (handle !== undefined) return;
      handle = setTimer(() => { if (isVisible()) void run(); }, intervalMs);
    },
    stop: () => {
      if (handle === undefined) return;
      clearTimer(handle);
      handle = undefined;
    },
    refresh: run,
    running: () => handle !== undefined,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The most recent read among every source that fed the panel. The full console
 * load and the alert poll both read this dataset, and the stamp must describe
 * the data actually on screen rather than whichever source ran last.
 */
export function latestRefreshAt(...values: Array<Date | undefined>): Date | undefined {
  return values.reduce<Date | undefined>(
    (latest, value) => (value && (!latest || value.getTime() > latest.getTime()) ? value : latest),
    undefined,
  );
}

/** Deterministic local clock label; `toLocaleTimeString` varies by runtime ICU. */
export function formatAlertRefreshedAt(value: Date | undefined): string {
  if (!value) return "尚未刷新";
  return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export interface AlertPollingOptions {
  /** Polling only while the alert dataset is actually readable and in view. */
  enabled: boolean;
  /** Same contract as `AlertPollerOptions.poll`: `true` means a read landed. */
  poll: () => Promise<boolean>;
  intervalMs?: number;
}

export interface AlertPollingState {
  lastRefreshedAt?: Date;
  refreshing: boolean;
  refresh: () => Promise<boolean>;
}

export function useAlertPolling({ enabled, poll, intervalMs }: AlertPollingOptions): AlertPollingState {
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const pollerRef = useRef<AlertPoller | undefined>(undefined);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const poller = createAlertPoller({
      poll: () => pollRef.current(),
      onRefreshed: (at) => setLastRefreshedAt(at),
      ...(intervalMs === undefined ? {} : { intervalMs }),
    });
    pollerRef.current = poller;
    if (enabled) poller.start();
    const refreshNow = () => { void poller.refresh(); };
    // Coming back to a tab that sat open overnight must re-read immediately,
    // not after another full interval.
    const onVisibilityChange = () => { if (document.visibilityState !== "hidden") refreshNow(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", refreshNow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", refreshNow);
      poller.stop();
      pollerRef.current = undefined;
    };
  }, [enabled, intervalMs]);

  const refresh = useCallback(async () => {
    const poller = pollerRef.current;
    if (!poller) return false;
    setRefreshing(true);
    try {
      return await poller.refresh();
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { lastRefreshedAt, refreshing, refresh };
}
