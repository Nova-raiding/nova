import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { customerDeliveryWorkspaceOptions } from "./CustomerDeliveryPage.js";

const pageSource = readFileSync(new URL("./CustomerDeliveryPage.tsx", import.meta.url), "utf8");

describe("customer delivery workspace selection", () => {
  it("labels workspaces with enterprise identity and blocks disabled workspaces", () => {
    expect(customerDeliveryWorkspaceOptions([
      { workspaceId: "ws_active", enterpriseName: "Store Nova测试商家", status: "active", planName: "专业版", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 100, subscriptionStatus: "active", memberCount: 1 },
      { workspaceId: "ws_disabled", enterpriseName: "已停用商家", status: "disabled", planName: "基础版", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 10, subscriptionStatus: "inactive", memberCount: 0 },
    ])).toEqual([
      { value: "ws_active", label: "Store Nova测试商家 · ws_active", disabled: false },
      { value: "ws_disabled", label: "已停用商家 · ws_disabled", disabled: true },
    ]);
  });

  it("provides an explicit accessible selector instead of an unactionable scope warning", () => {
    expect(pageSource).toContain('aria-label="客户交付目标企业工作区"');
    expect(pageSource).toContain("model.setAuthorizationTargetWorkspaceId");
    expect(pageSource).toContain('model.authorization.can("customer.delivery.update")');
    expect(pageSource).toContain("disabled={!canUpdate || !targetWorkspaceId}");
    expect(pageSource).toContain('const targetWorkspaceId = canBrowseWorkspaces ? model.authorizationTargetWorkspaceId?.trim() || "" : ""');
    expect(pageSource).toContain('key={targetWorkspaceId || "unselected"}');
    expect(pageSource).toContain("setRecords([])");
  });
});
