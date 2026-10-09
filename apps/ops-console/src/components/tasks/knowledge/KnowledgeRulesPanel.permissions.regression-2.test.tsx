import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "antd";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import { clearKnowledgeRuleScopeValueForGlobal, KnowledgeRulesPanel, knowledgeRuleScopeValueError } from "./KnowledgeRulesPanel";

function ReadOnlyRulesHarness() {
  const [knowledgeRuleForm] = Form.useForm();
  const model = {
    canKnowledge: true,
    canRules: false,
    createKnowledgeRule: vi.fn(),
    updateKnowledgeRule: vi.fn(),
    knowledgeRuleForm,
    knowledgeRules: [],
  } as unknown as OpsConsoleModel;
  return <KnowledgeRulesPanel model={model} />;
}

describe("KnowledgeRulesPanel rule-admin boundary", () => {
  it("requires a value for scoped rules but allows global rules to omit one", () => {
    expect(knowledgeRuleScopeValueError("platform", "  ")).toBe("限定作用域必须填写作用域值");
    expect(knowledgeRuleScopeValueError("category", undefined)).toBe("限定作用域必须填写作用域值");
    expect(knowledgeRuleScopeValueError("store", "store-1")).toBeUndefined();
    expect(knowledgeRuleScopeValueError("global", undefined)).toBeUndefined();
  });

  it("clears a previous scoped value when the operator switches to global", () => {
    const setFieldValue = vi.fn();
    clearKnowledgeRuleScopeValueForGlobal("platform", setFieldValue);
    expect(setFieldValue).not.toHaveBeenCalled();
    clearKnowledgeRuleScopeValueForGlobal("global", setFieldValue);
    expect(setFieldValue).toHaveBeenCalledWith("scopeValue", undefined);
  });

  it("explains that only scoped rules require a scope value", () => {
    const html = renderToStaticMarkup(<ReadOnlyRulesHarness />);
    expect(html).toContain("限定作用域必填；全局作用域留空");
  });

  // Regression: ISSUE-002 — content editors saw an enabled rule form that only
  // failed after submit because the UI used canKnowledge instead of canRules.
  // Found by /qa browser verification on 2026-09-08.
  it("disables rule creation for a content editor without rule governance capability", () => {
    const html = renderToStaticMarkup(<ReadOnlyRulesHarness />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*录入知识规则.*<\/button>/u);
    expect(html).not.toContain("生效</div>");
    expect(html).toContain("草稿（录入后单独启用）");
  });
});
