import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "antd";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import { KnowledgeRulesPanel } from "./KnowledgeRulesPanel";

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
  // Regression: ISSUE-002 — content editors saw an enabled rule form that only
  // failed after submit because the UI used canKnowledge instead of canRules.
  // Found by /qa browser verification on 2026-09-08.
  it("disables rule creation for a content editor without rule governance capability", () => {
    const html = renderToStaticMarkup(<ReadOnlyRulesHarness />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*录入知识规则.*<\/button>/u);
  });
});
