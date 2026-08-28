import { describe, expect, it, vi } from "vitest";
import { selectStoreScope } from "./OpsConsoleController.js";

describe("selectStoreScope", () => {
  it("updates the selected store and loads its automation scope", async () => {
    const setSelectedStoreScope = vi.fn();
    const loadAutomationScope = vi.fn(async () => undefined);

    await expect(selectStoreScope(
      { setSelectedStoreScope, loadAutomationScope },
      "douyin:store-2",
    )).resolves.toBeUndefined();
    expect(setSelectedStoreScope).toHaveBeenCalledWith("douyin:store-2");
    expect(loadAutomationScope).toHaveBeenCalledWith("douyin:store-2");
  });
});
