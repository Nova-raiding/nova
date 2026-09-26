import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RulesPage } from "./RulesPage.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";

function rulesModel(options: { consoleError?: string; ruleError?: string; platform?: boolean; canReadRules?: boolean } = {}) {
  return {
    // The console-level error is written by *any* failing optional dataset and
    // cleared whenever `loadRules` succeeds; it is not rule-scoped.
    error: options.consoleError,
    // Dataset-scoped reads are keyed by MCP method, like the real model.
    dataSetError: (...methods: string[]) =>
      methods.includes("rule.list") ? options.ruleError : undefined,
    ruleSyncLoading: false,
    ruleSyncStatuses: [],
    rules: [],
    authorization: { scope: { kind: options.platform ? "platform" : "workspace", id: "ws-1" }, can: (capability: string) => capability === "rule.read" && options.canReadRules === true },
    ruleMutationKey: undefined,
    canRules: false,
    loadRules: async () => undefined,
    syncRulesNow: async () => false,
    updateRuleStatus: async () => undefined,
    publishRuleDraft: async () => undefined,
  } as unknown as OpsConsoleModel;
}

const render = (options: { consoleError?: string; ruleError?: string; platform?: boolean; canReadRules?: boolean } = {}) =>
  renderToStaticMarkup(<RulesPage model={rulesModel(options)} />);

describe("rules page error scope", () => {
  it("never reports an unrelated dataset failure as a rule sync failure", () => {
    const html = render({
      consoleError:
        "部分数据集刷新失败（ops.storage.reconciliation.list）。页面保留上次成功数据，这些值可能已过期：HTTP 500",
    });
    expect(html).not.toContain("规则同步状态读取失败");
    expect(html).not.toContain("ops.storage.reconciliation.list");
  });

  it("still surfaces a failing rule dataset on both rule surfaces", () => {
    const html = render({ ruleError: "规则数据加载失败，请重试；空列表不代表没有平台规则。" });
    expect(html).toContain("规则同步状态读取失败");
    expect(html).toContain("规则数据加载失败，请重试");
  });

  it("mounts public draft review only in the platform workbench", () => {
    expect(render()).not.toContain("公共平台规则草稿审核");
    expect(render({ platform: true, canReadRules: true })).toContain("公共平台规则草稿审核");
  });
});
