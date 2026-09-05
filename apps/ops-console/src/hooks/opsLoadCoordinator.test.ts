import { describe, expect, it } from "vitest";
import { applyLoadedValue, OpsLoadCoordinator } from "./opsLoadCoordinator.js";

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

  it("preserves existing section data on failure but accepts a successful empty result", () => {
    let rows = ["existing"];

    expect(applyLoadedValue(undefined, (value: string[]) => { rows = value; })).toBe(false);
    expect(rows).toEqual(["existing"]);
    expect(applyLoadedValue([], (value: string[]) => { rows = value; })).toBe(true);
    expect(rows).toEqual([]);
  });
});
