import { describe, expect, it, vi } from "vitest";
import { commitOpsWorkbenchTransition } from "./OpsConsoleController.js";

describe("ops workbench transition", () => {
  it("aborts before committing context and URL atomically", () => {
    const events: string[] = [];
    const push = vi.fn((url: string) => events.push(`push:${url}`));
    const target = commitOpsWorkbenchTransition("platform", true, {
      abort: () => events.push("abort"),
      persist: (workbench) => events.push(`persist:${workbench}`),
      location: { pathname: "/ops/overview", search: "?tab=health", hash: "" },
      push,
      replace: vi.fn(),
    });

    expect(target).toBe("/ops/overview?tab=health&workbench=platform");
    expect(events).toEqual(["abort", "persist:platform", `push:${target}`]);
  });
});
