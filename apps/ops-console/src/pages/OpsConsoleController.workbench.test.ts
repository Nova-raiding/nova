import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { canActivateOpsWorkbench, commitOpsWorkbenchTransition, domainNavigationBlockedReason, initialOpsWorkbench, popstateWorkbenchWarning, shouldConfirmWorkbenchTransition, workbenchSwitchWarning } from "./OpsConsoleController.js";
import { opsDomains, requiredWorkbenchForDomain } from "../navigation/opsNavigation.js";
import { hasRuleDraftChanges, validateRuleChecksJson } from "../components/tasks/RuleCenterSection.js";

describe("ops workbench transition", () => {
  it("uses the platform workbench for a customer-delivery deep link despite stale workspace state", () => {
    expect(initialOpsWorkbench({ pathname: "/ops/customer-delivery", search: "", hash: "" }, "workspace")).toBe("platform");
    expect(initialOpsWorkbench({ pathname: "/ops/tasks", search: "", hash: "" }, "platform")).toBe("workspace");
  });

  it("honors an explicit workbench route intent", () => {
    expect(initialOpsWorkbench({ pathname: "/ops/customer-delivery", search: "?workbench=workspace", hash: "" }, "platform")).toBe("workspace");
  });

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

  it("names both workbench boundaries and every draft that will be discarded", () => {
    expect(workbenchSwitchWarning("workspace", "platform", ["事故创建表单", "规则草稿表单"])).toBe(
      "当前在商家工作区，切换到平台控制台将清除未保存内容：事故创建表单、规则草稿表单。该内容无法恢复。",
    );
  });

  it("keeps every in-console domain link reachable from the platform workbench", () => {
    // `navigateToDomain` refuses exactly the domains whose workbench cannot be
    // activated. Anything else would render a control that can never fire.
    for (const domain of opsDomains) {
      const required = requiredWorkbenchForDomain(domain);
      const reachable = required === undefined || canActivateOpsWorkbench(required);
      expect(domainNavigationBlockedReason(domain, "platform") === undefined).toBe(reachable);
    }
  });

  it("names the reason a merchant-workspace domain cannot be opened from the platform console", () => {
    expect(domainNavigationBlockedReason("members", "platform")).toContain("属于商家工作区");
    expect(domainNavigationBlockedReason("tasks", "platform")).toContain("属于商家工作区");
    expect(domainNavigationBlockedReason("knowledge", "platform")).toContain("属于商家工作区");
    expect(domainNavigationBlockedReason("rules", "platform")).toContain("属于商家工作区");
    expect(domainNavigationBlockedReason("members", "workspace")).toBeUndefined();
    expect(domainNavigationBlockedReason("users", "workspace")).toBeUndefined();
    expect(domainNavigationBlockedReason("overview", "platform")).toBeUndefined();
  });

  it("explains a history entry for a workbench the console can never enter", () => {
    // Backing into /ops/rules restores a merchant-workbench history entry that
    // can never be activated. The popstate used to be consumed silently.
    expect(popstateWorkbenchWarning("workspace", "platform")).toContain("商家工作区");
    expect(popstateWorkbenchWarning("workspace", "platform")).toContain("不可进入");
    expect(popstateWorkbenchWarning("platform", "workspace")).toBeUndefined();
    expect(popstateWorkbenchWarning("platform", "platform")).toBeUndefined();
    const controller = readFileSync(new URL("./OpsConsoleController.tsx", import.meta.url), "utf8");
    expect(controller).toContain("popstateWorkbenchWarning(targetWorkbench, activeWorkbench)");
  });

  it("no longer routes the 403 recovery action at an unreachable merchant domain", () => {
    const controller = readFileSync(new URL("./OpsConsoleController.tsx", import.meta.url), "utf8");
    const denied = readFileSync(new URL("../components/authz/AccessDeniedResult.tsx", import.meta.url), "utf8");
    expect(controller).not.toContain('navigateToDomain("members")');
    expect(denied).not.toContain("onViewPermissions");
  });

  it("recovers rule draft dirtiness from values after touched metadata is remounted", () => {
    expect(hasRuleDraftChanges({ checksJson: '{"forbiddenTerms":[]}' })).toBe(false);
    expect(hasRuleDraftChanges({ packId: "retained-draft", checksJson: '{"forbiddenTerms":[]}' })).toBe(true);
    expect(validateRuleChecksJson('{"forbiddenTerms":[]}')).toBeUndefined();
    expect(validateRuleChecksJson("标题不得夸大")).toBe("检查规则必须是合法 JSON");
    expect(validateRuleChecksJson("[]")).toBe("检查规则必须是 JSON 对象");
  });
});
