import { describe, expect, it, vi } from "vitest";
import { commitOpsWorkbenchTransition, shouldConfirmWorkbenchTransition } from "./OpsConsoleController.js";

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

  it("requires explicit confirmation only when a switch would discard dirty forms", () => {
    expect(shouldConfirmWorkbenchTransition("workspace", "platform", ["事故创建表单"])).toBe(true);
    expect(shouldConfirmWorkbenchTransition("workspace", "platform", [])).toBe(false);
    expect(shouldConfirmWorkbenchTransition("workspace", "workspace", ["规则草稿表单"])).toBe(false);
  });
});
