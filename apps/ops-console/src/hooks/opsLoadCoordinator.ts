export class OpsLoadCoordinator {
  private latestRequest = 0;

  begin() {
    this.latestRequest += 1;
    return this.latestRequest;
  }

  invalidate() {
    return this.begin();
  }

  isCurrent(request: number) {
    return request === this.latestRequest;
  }

  /**
   * Read the current generation without starting or invalidating a load.
   * A read that is not part of the coordinated load still has to notice that
   * the authorization boundary moved while it was on the wire; `begin()` would
   * cancel the console's in-flight load to make that point.
   */
  generation() {
    return this.latestRequest;
  }

  commit(request: number, update: () => void) {
    if (!this.isCurrent(request)) return false;
    update();
    return true;
  }
}

export function applyLoadedValue<T>(value: T | undefined, update: (loaded: T) => void) {
  if (value === undefined) return false;
  update(value);
  return true;
}

type OpsLoadFlight<T> = {
  payload: T;
  execute: (payload: T) => Promise<void>;
  rerun: boolean;
  cancelled: boolean;
  settled: Promise<void>;
  resolve: () => void;
  reject: (cause: unknown) => void;
};

/**
 * Runs at most one load per filter key at a time, but never drops a refresh.
 *
 * The previous in-flight key set returned early on a repeat call, so
 * `await load()` issued after a write could resolve without that write ever
 * being re-read: the row kept the pre-write value, the operator believed the
 * save failed and ran the audited write a second time. A repeat call now queues
 * exactly one follow-up run for the newest payload, and the promise handed back
 * resolves only once that follow-up settles — so the caller's `await` is bound
 * to data fetched after its mutation, not to the request that was already in
 * flight when it asked.
 *
 * `clear()` keeps the invalidation escape hatch: flights already running are
 * marked cancelled so they cannot replay, and a later load with the same key
 * starts a fresh flight immediately.
 */
export class OpsLoadRerunGate<T> {
  private readonly flights = new Map<string, OpsLoadFlight<T>>();

  /** Drop every tracked flight (authorization/workbench boundary change). */
  clear() {
    for (const flight of this.flights.values()) flight.cancelled = true;
    this.flights.clear();
  }

  /**
   * Load only when the key is idle. Reactive hydration (for example the
   * bootstrap effect re-firing when the resolved roles land while the first
   * load is still fanning out — that load already hydrates with the new
   * projection) is already covered by the in-flight run, and queueing a
   * follow-up there would double every bootstrap fan-out.
   */
  runIfIdle(key: string, payload: T, execute: (payload: T) => Promise<void>): Promise<void> {
    const inFlight = this.flights.get(key);
    if (inFlight) return inFlight.settled;
    return this.run(key, payload, execute);
  }

  run(key: string, payload: T, execute: (payload: T) => Promise<void>): Promise<void> {
    const inFlight = this.flights.get(key);
    if (inFlight) {
      // Track the newest intent so the follow-up re-reads what the operator
      // last asked for, and hand back a promise that outlives the queueing.
      inFlight.payload = payload;
      inFlight.execute = execute;
      inFlight.rerun = true;
      return inFlight.settled;
    }
    let resolve!: () => void;
    let reject!: (cause: unknown) => void;
    const settled = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const flight: OpsLoadFlight<T> = { payload, execute, rerun: false, cancelled: false, settled, resolve, reject };
    // The flight must be registered before the run starts: a run that settles
    // synchronously would otherwise delete the key before it was claimed.
    this.flights.set(key, flight);
    // A caller that ignores the returned promise (fire-and-forget refreshes)
    // must not turn a failed load into an unhandled rejection; callers that do
    // await it still observe the failure.
    settled.catch(() => undefined);
    void (async () => {
      let failure: unknown;
      try {
        do {
          flight.rerun = false;
          await flight.execute(flight.payload);
        } while (flight.rerun && !flight.cancelled);
      } catch (cause) {
        failure = cause;
      } finally {
        // Only the flight still owning the key clears it: `clear()` may have
        // already released the key for a replacement load.
        if (this.flights.get(key) === flight) this.flights.delete(key);
        if (failure === undefined) flight.resolve();
        else flight.reject(failure);
      }
    })();
    return settled;
  }
}
