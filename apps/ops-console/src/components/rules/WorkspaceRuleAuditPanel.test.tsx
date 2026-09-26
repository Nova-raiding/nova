import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Rule } from "../../types/ops.js";
import { buildRulePackOptions, parseRuleAuditEvents, WorkspaceRuleAuditPanel } from "./WorkspaceRuleAuditPanel.js";

const rules = [{ id: "r1", packId: "catalog-policy", name: "商品目录规则", version: "2", status: "active", scope: "platform", source: { kind: "official", reference: "https://example.test", checkedAt: "2026-09-01" }, revision: 2 }] as Rule[];
const event = (id: string, occurredAt: string) => ({
  id, workspaceId: "ws-1", rulePackId: "catalog-policy", ruleVersionId: "rule-v2", version: "2.0.0",
  action: "activated", actorId: "rules-admin", reason: "来源复核通过", occurredAt, data: { checksum: "abc123" },
});

describe("workspace rule audit panel", () => {
  it("orders events newest first and rejects malformed records", () => {
    expect(parseRuleAuditEvents([event("old", "2026-09-01T00:00:00.000Z"), event("new", "2026-09-02T00:00:00.000Z")]).map(item => item.id))
      .toEqual(["new", "old"]);
    expect(() => parseRuleAuditEvents({ events: [] })).toThrow("无法识别");
    expect(() => parseRuleAuditEvents([event("bad-date", "not-a-date")])).toThrow("无法识别");
  });

  it("builds a readable selector from the loaded rule packs", () => {
    expect(buildRulePackOptions(rules)).toEqual([
      { value: "", label: "全部规则包" },
      { value: "catalog-policy", label: "商品目录规则 · catalog-policy" },
    ]);
  });

  it("does not expose a workspace audit request surface without rule.read", () => {
    expect(renderToStaticMarkup(<WorkspaceRuleAuditPanel rules={rules} canRead={false} workspaceId="ws-1" />)).toBe("");
  });

  it("offers known rule packs and describes the workspace scope", () => {
    const html = renderToStaticMarkup(<WorkspaceRuleAuditPanel rules={rules} canRead workspaceId="ws-1" />);
    expect(html).toContain("工作区规则审计");
    expect(html).toContain("审计范围：ws-1");
    expect(html).toContain("按规则包筛选审计记录");
    expect(html).not.toContain("输入 pack_id");
  });
});
