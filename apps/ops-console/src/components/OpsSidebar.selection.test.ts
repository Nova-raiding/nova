import { describe, expect, it, vi } from "vitest";
import { selectStoreAndNavigate } from "./OpsSidebar.js";

describe("OpsSidebar store selection", () => {
  it("forwards a concrete store scope before navigating to stores", async () => {
    const events: string[] = [];
    const select = vi.fn(async (scope: string) => { events.push(`select:${scope}`); });
    const navigate = vi.fn(() => { events.push("navigate:stores"); });

    await selectStoreAndNavigate("jd:store-1", select, navigate);

    expect(select).toHaveBeenCalledWith("jd:store-1");
    expect(navigate).toHaveBeenCalledWith("stores");
    expect(events).toEqual(["select:jd:store-1", "navigate:stores"]);
  });

  it("forwards an empty scope for the all-stores entry", async () => {
    const select = vi.fn(async () => undefined);

    await selectStoreAndNavigate("", select, vi.fn());

    expect(select).toHaveBeenCalledWith("");
  });
});
