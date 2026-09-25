import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleCenterSection, isOfficialPlatformRule, parseMarkdownDraftInputs } from "./RuleCenterSection";
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
    expect(html).toContain("平台规则人工导入说明");
    expect(html).toContain("不会进入商家规则、生成预检或发布前复检");
    expect(html).toContain("受信签名清单");
    expect(html).not.toContain("独立审批并激活");
    expect(html).not.toContain("rule-draft-create");
    expect(html).not.toContain("创建规则草稿");
  });

  it("validates every Markdown card before any upload can be started", () => {
    const markdown = [
      "# 知识库 v2026.09",
      "## PDD-001｜标题规则",
      "- 平台：拼多多",
      "- 官方依据：https://official.example/pdd/title",
      "标题不得夸大",
      "## PDD-002｜图片规则",
      "- 平台：拼多多",
      "- 官方依据：https://official.example/pdd/image",
      "图片需清晰",
    ].join("\n");
    expect(parseMarkdownDraftInputs(markdown, "pdd.md")).toHaveLength(2);
    expect(() => parseMarkdownDraftInputs(markdown.replace("- 官方依据：https://official.example/pdd/title", "- 依据缺失"), "pdd.md")).toThrow("PDD-001 缺少平台或官方依据字段");
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
