import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Form } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel.js";
import { CompetitorReferencesPanel, safeCompetitorSourceHref } from "./CompetitorReferencesPanel.js";

describe("competitor reference source links", () => {
  it("allows public HTTPS links and rejects unsafe schemes, credentials, and custom ports", () => {
    expect(safeCompetitorSourceHref("https://example.com/products?id=1")).toBe("https://example.com/products?id=1");
    for (const value of ["javascript:alert(1)", "http://example.com", "https://user@example.com/", "https://example.com:8443/"]) {
      expect(safeCompetitorSourceHref(value)).toBeUndefined();
    }
  });

  it("renders unsafe stored source URLs as text instead of clickable links", () => {
    function Harness() {
      const [competitorForm] = Form.useForm();
      const model = {
        canCompetitor: false,
        competitorForm,
        competitors: [{
          id: "competitor-1", competitorName: "竞品 A",
          source: { url: "javascript:alert(1)", title: "不安全来源", accessedAt: "2026-10-09T00:00:00.000Z" },
          summary: "摘要", structure: { sections: [] }, sellingPoints: [], expression: { tone: [], formats: [] },
        }],
      } as unknown as OpsConsoleModel;
      return createElement(CompetitorReferencesPanel, { model });
    }

    const html = renderToStaticMarkup(createElement(Harness));
    expect(html).toContain("不安全来源（来源链接不安全）");
    expect(html).not.toContain('href="javascript:alert(1)"');
  });
});
