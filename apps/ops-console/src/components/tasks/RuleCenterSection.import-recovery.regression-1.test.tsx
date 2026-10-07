import { describe, expect, it, vi } from "vitest";
import { parseMarkdownDraftInputs, uploadMarkdownDrafts } from "./RuleCenterSection";

const markdown = [
  "## JD-RECOVERY-001｜京东规则一",
  "- 平台：京东",
  "- 官方依据：https://rule.jd.com/rule/ruleDetail.action?ruleId=1",
  "规则内容一",
  "## JD-RECOVERY-002｜京东规则二",
  "- 平台：京东",
  "- 官方依据：https://rule.jd.com/rule/ruleDetail.action?ruleId=2",
  "规则内容二",
].join("\n");

describe("rule Markdown import API failure recovery", () => {
  it("rejects a rule card with official metadata but no actual rule content", () => {
    const metadataOnly = markdown.replace("规则内容一\n## JD-RECOVERY-002", "\n## JD-RECOVERY-002");

    expect(() => parseMarkdownDraftInputs(metadataOnly, "empty-content.md"))
      .toThrow("JD-RECOVERY-001 缺少规则内容");
  });

  it("reports the rejected card and continues submitting later cards", async () => {
    const drafts = parseMarkdownDraftInputs(markdown, "recovery.md");
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error("规则 API 暂时不可用"))
      .mockResolvedValueOnce(true);

    await expect(uploadMarkdownDrafts(drafts, publish)).resolves.toEqual({
      succeeded: 1,
      failedCard: "jd-recovery-001",
      reason: "规则 API 暂时不可用",
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map(([draft]) => draft.packId)).toEqual([
      "jd-manual-jd-recovery-001",
      "jd-manual-jd-recovery-002",
    ]);
  });

  it("uses a safe fallback when the rejected API response is not an Error", async () => {
    const drafts = parseMarkdownDraftInputs(markdown, "recovery.md");
    const publish = vi.fn()
      .mockRejectedValueOnce({ code: "UPSTREAM_FAILURE" })
      .mockResolvedValueOnce(true);

    await expect(uploadMarkdownDrafts(drafts, publish)).resolves.toEqual({
      succeeded: 1,
      failedCard: "jd-recovery-001",
      reason: "规则服务拒绝了该卡片",
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
