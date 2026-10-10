import { describe, expect, it, vi } from "vitest";
import { runSingleFlight } from "./singleFlight.js";

describe("runSingleFlight", () => {
  it("ignores a second approval while the first request is pending", async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const lock = { current: false };

    const first = runSingleFlight(lock, action);
    await runSingleFlight(lock, action);

    expect(action).toHaveBeenCalledOnce();
    expect(lock.current).toBe(true);
    finish();
    await first;
    expect(lock.current).toBe(false);
  });

  it("releases the approval guard after a failed request so the operator can retry", async () => {
    const lock = { current: false };
    const action = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(undefined);

    await expect(runSingleFlight(lock, action)).rejects.toThrow("temporary failure");
    expect(lock.current).toBe(false);
    await runSingleFlight(lock, action);
    expect(action).toHaveBeenCalledTimes(2);
  });
});
