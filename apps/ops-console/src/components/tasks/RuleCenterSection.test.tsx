import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleCenterSection, canActivateOfficialPlatformRule, isTrustedPlatformRule, parseMarkdownDraftInputs, readRuleMarkdownDocuments, ruleTrustLabel, uploadMarkdownDrafts } from "./RuleCenterSection";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Platform, Rule } from "../../types/ops";

const sourceForPlatform = (platform: string) => ({
  jd: "https://rule.jd.com/rule/ruleDetail.action?ruleId=1", 京东: "https://rule.jd.com/rule/ruleDetail.action?ruleId=1",
  taobao: "https://developer.alibaba.com/doc/doc.htm?articleId=1", 淘宝: "https://developer.alibaba.com/doc/doc.htm?articleId=1",
  tmall: "https://www.tmall.com/wow/seller/act/guize/article", 天猫: "https://www.tmall.com/wow/seller/act/guize/article",
  pinduoduo: "https://www.yangkeduo.com/home/help/", 拼多多: "https://www.yangkeduo.com/home/help/",
  xiaohongshu: "https://school.xiaohongshu.com/rule/detail/1", 小红书: "https://school.xiaohongshu.com/rule/detail/1",
  douyin: "https://school.jinritemai.com/doudian/web/article/1", 抖音: "https://school.jinritemai.com/doudian/web/article/1",
}[platform] ?? "https://invalid.example/rule");

const markdownCard = (id: string, platform: string) => [
  `## PDD-${id}｜规则 ${id}`,
  `- 平台：${platform}`,
  `- 官方依据：${sourceForPlatform(platform)}`,
  "规则内容",
].join("\n");

const platformRule = (overrides: Partial<Rule> = {}): Rule => ({
  id: "rule-1", packId: "pack-1", name: "标题规范", version: "v1", status: "draft", scope: "platform", revision: 1,
  activationEligible: false,
  source: { kind: "internal", trust: "unverified", reference: "manual://rules.md#PDD-001", checkedAt: "2026-09-01" },
  ...overrides,
});

describe("trusted platform rule boundary", () => {
  it("distinguishes approved internal rules from untrusted material", () => {
    const source = { kind: "official", trust: "verified", reference: "https://rule.jd.com/rule/list.action" };
    expect(isTrustedPlatformRule({ source, scope: "platform", targetId: "jd", createdBy: "signed-rule-sync" } as Parameters<typeof isTrustedPlatformRule>[0])).toBe(true);
    expect(isTrustedPlatformRule({ source: { kind: "internal", trust: "verified", reference: "https://www.yangkeduo.com/home/help/" }, scope: "platform", targetId: "pinduoduo" } as Parameters<typeof isTrustedPlatformRule>[0])).toBe(true);
    for (const override of [{ kind: "internal" }, { trust: "unverified" }, { reference: "manual://rule" }]) {
      expect(isTrustedPlatformRule({ source: { ...source, ...override } } as Parameters<typeof isTrustedPlatformRule>[0])).toBe(false);
    }
  });
  it("requires platform binding, importer identity, and default HTTPS port for signed trust", () => {
    expect(isTrustedPlatformRule({ source: { kind: "official", trust: "verified", reference: "https://www.yangkeduo.com:8443/home/help/" }, scope: "platform", targetId: "pinduoduo", createdBy: "signed-rule-sync" } as Parameters<typeof isTrustedPlatformRule>[0])).toBe(false);
    expect(isTrustedPlatformRule({ source: { kind: "official", trust: "verified", reference: "https://rule.jd.com/rule/list.action" }, scope: "platform", targetId: "taobao", createdBy: "signed-rule-sync" } as Parameters<typeof isTrustedPlatformRule>[0])).toBe(false);
    expect(isTrustedPlatformRule({ source: { kind: "official", trust: "verified", reference: "https://rule.jd.com/rule/list.action" }, scope: "platform", targetId: "jd", createdBy: "operator" } as Parameters<typeof isTrustedPlatformRule>[0])).toBe(false);
  });
  it("does not label mismatched provenance as signed or approved", () => {
    expect(ruleTrustLabel({ source: { kind: "official", trust: "verified", reference: "manual://misclassified" } } as Parameters<typeof ruleTrustLabel>[0])).toBe("来源类型不匹配");
    expect(ruleTrustLabel({ source: { kind: "internal", trust: "verified", reference: "https://www.yangkeduo.com/home/help/" }, scope: "platform", targetId: "pinduoduo" } as Parameters<typeof ruleTrustLabel>[0])).toBe("人工已审批");
  });
  it("does not expose an internal draft creation form on the official rules page", () => {
    const html = renderToStaticMarkup(<RuleCenterSection model={{ canRules: true, rules: [], updateRuleStatus: async () => true } as unknown as OpsConsoleModel} />);
    expect(html).toContain("平台规则人工导入说明");
    expect(html).toContain("不会进入商家插件");
    expect(html).toContain("独立审批");
    expect(html).not.toContain("rule-draft-create");
    expect(html).not.toContain("创建规则草稿");
  });

  it("does not describe an approved manual source as independently verified", () => {
    const html = renderToStaticMarkup(<RuleCenterSection model={{
      canRules: false,
      rules: [{ id: "manual", packId: "pdd", name: "平台条款", version: "1", status: "active", scope: "platform", targetId: "pinduoduo", revision: 2, source: { kind: "internal", reference: "https://www.yangkeduo.com/home/help/", checkedAt: "2026-08-26T06:00:00.000Z", trust: "verified" } }],
      updateRuleStatus: async () => true,
    } as unknown as OpsConsoleModel} />);
    expect(html).toContain("人工已审批");
    expect(html).not.toContain("签名来源已验证");
  });

  it("validates every Markdown card before any upload can be started", () => {
    const markdown = [
      "# 知识库 v2026.09",
      "## PDD-001｜标题规则",
      "- 平台：拼多多",
      "- 官方依据：https://www.yangkeduo.com/home/help/",
      "标题不得夸大",
      "## PDD-002｜图片规则",
      "- 平台：拼多多",
      "- 官方依据：https://www.yangkeduo.com/home/food_trade/",
      "图片需清晰",
    ].join("\n");
    expect(parseMarkdownDraftInputs(markdown, "pdd.md")).toHaveLength(2);
    expect(() => parseMarkdownDraftInputs(markdown.replace("- 官方依据：https://www.yangkeduo.com/home/help/", "- 依据缺失"), "pdd.md")).toThrow("PDD-001 缺少平台或官方依据字段");
  });

  it("maps all six platform ids and Chinese names to canonical ids", () => {
    const platforms: Array<[Platform, string]> = [
      ["jd", "京东"], ["taobao", "淘宝"], ["tmall", "天猫"],
      ["pinduoduo", "拼多多"], ["xiaohongshu", "小红书"], ["douyin", "抖音"],
    ];
    for (const [id, label] of platforms) {
      expect(parseMarkdownDraftInputs(markdownCard("001", id), "rules.md")[0]?.targetId).toBe(id);
      expect(parseMarkdownDraftInputs(markdownCard("001", label), "rules.md")[0]?.targetId).toBe(id);
    }
  });

  it("accepts the card prefixes and official source hosts used by the supplied platform rule packages", () => {
    const cases: Array<[string, string, string]> = [
      ["JD-GEN-001", "京东", "https://helpcenter.jd.com/vender/issue/1000-44348.html"],
      ["TB-GEN-001", "淘宝", "https://developer.alibaba.com/api.htm?apiId=147"],
      ["TM-GEN-001", "天猫", "https://developer.alibaba.com/docs/doc.htm?articleId=108953&docType=1&treeId=796"],
      ["PDD-GEN-001", "拼多多", "https://mms.pinduoduo.com/other/rule?listId=3&id=75"],
      ["DY-GEN-001", "抖店", "https://open.douyin.com/platform/resource/docs/ability/content-management/douyin-publish-solution"],
    ];
    for (const [cardId, platform, source] of cases) {
      const markdown = [
        "# Store Nova｜平台规则知识库 v0.1",
        `## ${cardId}｜规则卡片`,
        `- 平台：${platform}`,
        `- 官方依据：${source}`,
        "规则内容",
      ].join("\n");
      expect(parseMarkdownDraftInputs(markdown, `${cardId}.md`)[0]).toMatchObject({
        targetId: { 京东: "jd", 淘宝: "taobao", 天猫: "tmall", 拼多多: "pinduoduo", 抖店: "douyin" }[platform],
        sourceReference: source,
      });
    }
  });

  it("normalizes Markdown-linked official evidence to the raw URL sent to the rule API", () => {
    const markdown = [
      "# Store Nova｜京东平台规则知识库 v0.1",
      "## JD-GEN-001｜规则卡片",
      "- 平台：京东",
      "- 官方依据：[京东开放平台商品信息规范总则](https://rule.jd.com/rule/ruleDetail.action?ruleId=1126064694289895424&type=0&btype=1)，第三条",
      "规则内容",
    ].join("\n");
    expect(parseMarkdownDraftInputs(markdown, "jd.md")[0]).toMatchObject({
      sourceReference: "https://rule.jd.com/rule/ruleDetail.action?ruleId=1126064694289895424&type=0&btype=1",
    });
  });

  it("strips trailing Markdown-link punctuation from normalized official evidence", () => {
    const markdown = [
      "# Store Nova｜京东平台规则知识库 v0.1",
      "## JD-GEN-002｜规则卡片",
      "- 平台：京东",
      "- 官方依据：[京东规则页面](https://rule.jd.com/rule/ruleDetail.action?id=456)。",
      "规则内容",
    ].join("\n");
    expect(parseMarkdownDraftInputs(markdown, "jd.md")[0]?.sourceReference).toBe(
      "https://rule.jd.com/rule/ruleDetail.action?id=456",
    );
  });

  it("extracts only platform rule Markdown files from a supplied ZIP package", async () => {
    const zip = new JSZip();
    zip.file("StoreNova_京东平台规则_v0.1/01_上传文件/京东平台规则.md", [
      "# Store Nova｜京东平台规则知识库 v0.1",
      "## JD-GEN-001｜规则卡片",
      "- 平台：京东",
      "- 官方依据：https://rule.jd.com/rule/ruleDetail.action?ruleId=1",
      "规则内容",
    ].join("\n"));
    zip.file("StoreNova_京东平台规则_v0.1/02_查阅资料/待核实参数.md", "## PENDING-001｜不能上传");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const file = {
      name: "StoreNova_京东平台规则_v0.1.zip",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
    await expect(readRuleMarkdownDocuments(file)).resolves.toEqual([{
      name: "StoreNova_京东平台规则_v0.1.zip:StoreNova_京东平台规则_v0.1/01_上传文件/京东平台规则.md",
      text: expect.stringContaining("JD-GEN-001"),
    }]);
  });

  it("rejects an unknown platform in a later card before any draft write", () => {
    const publish = vi.fn(async () => true);
    expect(() => {
      const drafts = parseMarkdownDraftInputs(`${markdownCard("001", "京东")}\n${markdownCard("002", "火星商城")}`, "rules.md");
      void uploadMarkdownDrafts(drafts, publish);
    }).toThrow("PDD-002 的平台“火星商城”不受支持");
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports completed cards and the first failed card while continuing later writes", async () => {
    const drafts = parseMarkdownDraftInputs(`${markdownCard("001", "jd")}\n${markdownCard("002", "taobao")}\n${markdownCard("003", "tmall")}`, "rules.md");
    const publish = vi.fn(async (draft: typeof drafts[number]) => !draft.packId.includes("pdd-002"));
    expect(await uploadMarkdownDrafts(drafts, publish)).toEqual({
      succeeded: 2,
      failedCard: "pdd-002",
      reason: "规则服务拒绝了该卡片；请查看规则服务错误提示并核对官方依据。",
    });
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls.map(([draft]) => draft.packId)).toEqual(["jd-manual-pdd-001", "taobao-manual-pdd-002", "tmall-manual-pdd-003"]);
    const component = readFileSync(new URL("./RuleCenterSection.tsx", import.meta.url), "utf8");
    expect(component).toContain("Markdown 导入未完成");
    expect(component).toContain("成功 ${markdownImportResult.succeeded} 张");
    expect(component).toContain("失败卡片 ${markdownImportResult.failedCard}");
  });

  it("offers activation for a server-eligible manual draft but not a forged official manual source", () => {
    const approvedPath = platformRule({ id: "reviewed-manual", activationEligible: true });
    const forgedSource = platformRule({
      id: "forged-official", activationEligible: false,
      source: { kind: "official", trust: "verified", reference: "manual://forged", checkedAt: "2026-09-01" },
    });
    expect(canActivateOfficialPlatformRule(approvedPath)).toBe(true);
    expect(canActivateOfficialPlatformRule(forgedSource)).toBe(false);
    expect(isTrustedPlatformRule(forgedSource)).toBe(false);
    const html = renderToStaticMarkup(<RuleCenterSection model={{
      canRules: true, rules: [approvedPath, forgedSource], updateRuleStatus: async () => true,
    } as unknown as OpsConsoleModel} />);
    expect(html.match(/审批并激活/g)).toHaveLength(1);
    expect(html).toContain("来源类型不匹配");
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

  it("checks the dedicated rule capability before lifecycle mutations", () => {
    const updateRuleStatusStart = modelSource.indexOf("const updateRuleStatus = async (");
    const publishRuleDraftStart = modelSource.indexOf("const publishRuleDraft = async (");
    expect(updateRuleStatusStart).toBeGreaterThan(-1);
    expect(publishRuleDraftStart).toBeGreaterThan(updateRuleStatusStart);
    const lifecycleSource = modelSource.slice(updateRuleStatusStart, publishRuleDraftStart);
    expect(lifecycleSource).toContain("if (!canRules)");
    expect(lifecycleSource).toContain("缺少规则管理员权限");
    expect(lifecycleSource).not.toContain("if (!canKnowledge)");
  });
});
