import { describe, expect, it, vi } from "vitest";
import { commitOpsWorkbenchTransition, shouldConfirmWorkbenchTransition } from "./OpsConsoleController.js";
import { hasRuleDraftChanges } from "../components/tasks/RuleCenterSection.js";

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

  it("runs cleanup only after the switch is accepted", () => {
    const events: string[] = [];
    commitOpsWorkbenchTransition("platform", true, {
      abort: () => events.push("abort"),
      persist: (workbench) => events.push(`persist:${workbench}`),
      location: { pathname: "/ops/overview", search: "", hash: "" },
      push: () => events.push("push"),
      replace: () => events.push("replace"),
    }, () => events.push("clear-old-data"));

    expect(events).toEqual(["abort", "clear-old-data", "persist:platform", "push"]);
  });

  it("requires explicit confirmation only when a switch would discard dirty forms", () => {
    expect(shouldConfirmWorkbenchTransition("workspace", "platform", ["事故创建表单"])).toBe(true);
    expect(shouldConfirmWorkbenchTransition("workspace", "platform", [])).toBe(false);
    expect(shouldConfirmWorkbenchTransition("workspace", "workspace", ["规则草稿表单"])).toBe(false);
  });

  it("recovers rule draft dirtiness from values after touched metadata is remounted", () => {
    expect(hasRuleDraftChanges({ checksJson: '{"forbiddenTerms":[]}' })).toBe(false);
    expect(hasRuleDraftChanges({ packId: "retained-draft", checksJson: '{"forbiddenTerms":[]}' })).toBe(true);
  });
});
