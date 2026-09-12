import { describe, expect, it } from "vitest";
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
