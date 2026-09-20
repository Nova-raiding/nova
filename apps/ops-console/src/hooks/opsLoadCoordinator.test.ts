import { describe, expect, it } from "vitest";
import { applyLoadedValue, OpsLoadCoordinator, OpsLoadRerunGate } from "./opsLoadCoordinator.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

describe("OpsLoadCoordinator", () => {
  it("lets the newest global load win when an older request finishes last", () => {
    const coordinator = new OpsLoadCoordinator();
    const older = coordinator.begin();
    const newer = coordinator.begin();
    const committed: string[] = [];

    expect(coordinator.commit(newer, () => committed.push("newer"))).toBe(true);
    expect(coordinator.commit(older, () => committed.push("older"))).toBe(false);
    expect(committed).toEqual(["newer"]);
  });

  it("invalidates an in-flight section load when its scope is cleared", () => {
    const coordinator = new OpsLoadCoordinator();
    const oldRequest = coordinator.begin();
    coordinator.invalidate();
    const update = () => undefined;

    expect(coordinator.commit(oldRequest, update)).toBe(false);
  });

  it("reports the generation without cancelling the load it belongs to", () => {
    // A read that is not part of the coordinated load (the 60s alert poll) has
    // to notice a boundary clear that happens while it is on the wire. `begin()`
    // would invalidate the console's own in-flight load to make that point.
    const coordinator = new OpsLoadCoordinator();
    const inFlight = coordinator.begin();
    const generation = coordinator.generation();

    expect(coordinator.isCurrent(inFlight)).toBe(true);

    // The boundary clear is what invalidates the polled read.
    coordinator.invalidate();
    expect(coordinator.generation()).not.toBe(generation);
  });

  it("preserves existing section data on failure but accepts a successful empty result", () => {
    let rows = ["existing"];

    expect(applyLoadedValue(undefined, (value: string[]) => { rows = value; })).toBe(false);
    expect(rows).toEqual(["existing"]);
    expect(applyLoadedValue([], (value: string[]) => { rows = value; })).toBe(true);
    expect(rows).toEqual([]);
  });
});

describe("OpsLoadRerunGate", () => {
  it("loads a repeat refresh requested while the same filters are in flight", async () => {
    // Regression: the in-flight key set returned early on a repeat call, so
    // `await load()` after a save resolved against the pre-save request and the
    // operator re-ran the audited write.
    const gate = new OpsLoadRerunGate<{ filters: string }>();
    const runs: string[] = [];
    const first = deferred();
    const followUp = deferred();

    void gate.run("queue=a", { filters: "a" }, async () => { runs.push("first"); await first.promise; });
    let callerSettled = false;
    const queued = gate
      .run("queue=a", { filters: "a" }, async () => { runs.push("follow-up"); await followUp.promise; })
      .then(() => { callerSettled = true; });

    expect(runs).toEqual(["first"]);

    first.resolve();
    await flush();

    expect(runs).toEqual(["first", "follow-up"]);
    // The caller's `await` must outlive the request that was already running,
    // otherwise it observes data fetched before its own mutation.
    expect(callerSettled).toBe(false);

    followUp.resolve();
    await queued;
    expect(callerSettled).toBe(true);
  });

  it("collapses repeats into one follow-up that carries the newest filters", async () => {
    const gate = new OpsLoadRerunGate<{ filters: string }>();
    const seen: string[] = [];
    const first = deferred();
    const followUp = deferred();

    void gate.run("queue=a", { filters: "a" }, async () => { seen.push("first"); await first.promise; });
    void gate.run("queue=a", { filters: "a" }, async (payload) => { seen.push(`repeat:${payload.filters}`); });
    const latest = gate.run("queue=a", { filters: "b" }, async (payload) => { seen.push(`repeat:${payload.filters}`); await followUp.promise; });

    first.resolve();
    await flush();
    expect(seen).toEqual(["first", "repeat:b"]);

    followUp.resolve();
    await latest;
    expect(seen).toEqual(["first", "repeat:b"]);
  });

  it("does not double a reactive hydration that the in-flight load already covers", async () => {
    // The bootstrap effect re-fires when the resolved roles land mid-flight;
    // that load already hydrates with the new authorization, so it must not
    // queue a second full fan-out.
    const gate = new OpsLoadRerunGate<{ filters: string }>();
    const runs: string[] = [];
    const first = deferred();

    void gate.run("queue=a", { filters: "a" }, async () => { runs.push("first"); await first.promise; });
    void gate.runIfIdle("queue=a", { filters: "a" }, async () => { runs.push("idle-repeat"); });

    first.resolve();
    await flush();
    expect(runs).toEqual(["first"]);

    // An idle key still loads through runIfIdle.
    await gate.runIfIdle("queue=a", { filters: "a" }, async () => { runs.push("idle-load"); });
    expect(runs).toEqual(["first", "idle-load"]);
  });

  it("still runs filters that differ from the in-flight request", async () => {
    const gate = new OpsLoadRerunGate<{ filters: string }>();
    const seen: string[] = [];
    const first = deferred();

    const a = gate.run("queue=a", { filters: "a" }, async () => { seen.push("a"); await first.promise; });
    const b = gate.run("queue=b", { filters: "b" }, async () => { seen.push("b"); });
    await b;

    expect(seen).toEqual(["a", "b"]);
    first.resolve();
    await a;
  });

  it("releases the key after a failed run and still resolves the queued caller", async () => {
    const gate = new OpsLoadRerunGate<{ filters: string }>();
    const seen: string[] = [];

    await expect(gate.run("queue=a", { filters: "a" }, async () => {
      throw new Error("boom");
    })).rejects.toThrowError("boom");

    // The failure must not leave the key pinned, or every later refresh of the
    // same filters would be swallowed exactly like the original defect.
    await gate.run("queue=a", { filters: "a" }, async () => { seen.push("recovered"); });
    expect(seen).toEqual(["recovered"]);
  });

  it("cancels a queued follow-up when the authorization boundary is cleared", async () => {
    const gate = new OpsLoadRerunGate<{ filters: string }>();
    const seen: string[] = [];
    const first = deferred();

    void gate.run("queue=a", { filters: "a" }, async () => { seen.push("first"); await first.promise; });
    void gate.run("queue=a", { filters: "a" }, async () => { seen.push("stale-follow-up"); });
    gate.clear();

    first.resolve();
    await flush();

    expect(seen).toEqual(["first"]);
    // A cleared gate must accept the replacement load immediately.
    await gate.run("queue=a", { filters: "a" }, async () => { seen.push("replacement"); });
    expect(seen).toEqual(["first", "replacement"]);
  });
});
