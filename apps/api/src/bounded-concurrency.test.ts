import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./bounded-concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves input order while bounding active work", async () => {
    let active = 0;
    let maximumActive = 0;
    const release: Array<() => void> = [];
    const mapped = mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return value * 10;
    });

    await expect.poll(() => release.length).toBe(2);
    for (let completed = 0; completed < 5; completed += 1) {
      await expect.poll(() => release.length).toBeGreaterThan(0);
      release.shift()?.();
    }

    await expect(mapped).resolves.toEqual([10, 20, 30, 40, 50]);
    expect(maximumActive).toBe(2);
  });

  it("rejects invalid concurrency and supports empty input", async () => {
    await expect(mapWithConcurrency([], 2, async () => 1)).resolves.toEqual([]);
    await expect(mapWithConcurrency([1], 0, async value => value)).rejects.toThrow(
      "positive integer",
    );
  });
});
