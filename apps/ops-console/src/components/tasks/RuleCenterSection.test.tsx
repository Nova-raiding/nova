import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleCenterSection, isOfficialPlatformRule } from "./RuleCenterSection";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

describe("official platform rule boundary", () => {
  it("never presents internal or unverified rules as platform restrictions", () => {
    const source = { kind: "official", trust: "verified", reference: "https://rules.example/rule" };
    expect(isOfficialPlatformRule({ source } as Parameters<typeof isOfficialPlatformRule>[0])).toBe(true);
    for (const override of [{ kind: "internal" }, { trust: "unverified" }, { reference: "manual://rule" }]) {
      expect(isOfficialPlatformRule({ source: { ...source, ...override } } as Parameters<typeof isOfficialPlatformRule>[0])).toBe(false);
    }
  });
  it("does not expose an internal draft creation form on the official rules page", () => {
    const html = renderToStaticMarkup(<RuleCenterSection model={{ canRules: true, rules: [], updateRuleStatus: async () => true } as unknown as OpsConsoleModel} />);
    expect(html).toContain("平台官方限制规则");
    expect(html).not.toContain("rule-draft-create");
    expect(html).not.toContain("创建规则草稿");
  });
});

describe("rule activation approval transport", () => {
  const source = readFileSync(new URL("./RuleCenterSection.tsx", import.meta.url), "utf8");
  const modelSource = readFileSync(new URL("../../hooks/useOpsConsoleModel.ts", import.meta.url), "utf8");

  it("takes the approver credential as a token the approver supplies, not a typed name", () => {
    // The `approval` obligation is resolved server-side from the token grant
    // alone (parseApprovalGrant in apps/api/src/server.ts), so a typed approver
    // id proves nothing and under requiresStrictAuth() the activation is
    // rejected before it can ever succeed (RULE_APPROVAL_REQUIRED).
    expect(source).toContain("Input.Password");
    expect(source).toContain('label="审批人令牌"');
    expect(source).toContain('autoComplete="off"');
    expect(source).toContain("ruleApprovalToken: values.approvalToken");
    // A bearer credential must not outlive the submit it accompanied, and must
    // never reach browser storage.
    expect(source).toContain("activationForm.resetFields()");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    // The typed id survives only because the server still requires approved_by
    // in the body; it is a claim that must agree with the grant, not the proof.
    expect(source).toContain('label="审批人 ID"');
    expect(source).toContain("必须与令牌绑定的审批人一致");
    expect(source).toContain("审批证明来自审批人令牌");
    expect(source).not.toContain("请输入不同于当前操作者的审批人 ID");
  });

  it("sends the token as an OpsRpcOptions header, never as an rpc param", () => {
    const callIndex = modelSource.indexOf('rpc("rule.status", {');
    const optionsIndex = modelSource.indexOf("}, { ruleApprovalToken: options?.ruleApprovalToken?.trim() })", callIndex);
    expect(callIndex).toBeGreaterThan(-1);
    expect(optionsIndex).toBeGreaterThan(callIndex);
    const paramsLiteral = modelSource.slice(callIndex, optionsIndex);
    // The server still requires approval_ref/approved_at (and approved_by) in
    // the body, so those must remain; the token must not.
    expect(paramsLiteral).toContain("approval_json");
    expect(paramsLiteral).toContain("approval_ref");
    expect(paramsLiteral).toContain("approved_at");
    expect(paramsLiteral).toContain("approved_by");
    expect(paramsLiteral).not.toContain("ruleApprovalToken");
  });
});
