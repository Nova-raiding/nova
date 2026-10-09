import { describe, expect, it, vi } from "vitest";
import { SingleFlightGate } from "./singleFlightGate.js";

describe("SingleFlightGate", () => {
  it("locks before confirmation and dispatches only once for rapid duplicate submits", async () => {
    const gate = new SingleFlightGate();
    let resolveConfirmation!: (confirmed: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { resolveConfirmation = resolve; }));
    const dispatch = vi.fn(async () => "created");
    const submit = () => gate.run(async () => {
      if (!await confirm()) return "cancelled";
      return dispatch();
    });

    const first = submit();
    const second = submit();
    await Promise.resolve();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await second).toBeUndefined();

    resolveConfirmation(true);
    await expect(first).resolves.toBe("created");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("releases after cancellation or failure so an intentional retry can proceed", async () => {
    const gate = new SingleFlightGate();
    await expect(gate.run(async () => "cancelled")).resolves.toBe("cancelled");
    await expect(gate.run(async () => { throw new Error("request failed"); })).rejects.toThrow("request failed");
    await expect(gate.run(async () => "retried")).resolves.toBe("retried");
  });
});
