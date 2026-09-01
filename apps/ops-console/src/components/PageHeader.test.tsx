import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader.js";

describe("PageHeader", () => {
  it("keeps a semantic heading, description relationship, and polite next-step status", () => {
    const markup = renderToStaticMarkup(
      <PageHeader
        eyebrow="ACCESS GOVERNANCE"
        title="成员与权限"
        description="管理当前工作区成员。"
        nextStep="先确认当前范围。"
        headingLevel={1}
        headingId="members-heading"
        descriptionId="members-description"
      />,
    );

    expect(markup).toContain('<h1 id="members-heading"');
    expect(markup).toContain('id="members-description"');
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain("当前下一步");
  });

  it("does not render an empty actions region when no primary action exists", () => {
    const markup = renderToStaticMarkup(
      <PageHeader
        eyebrow="FINANCE"
        title="账务与商业配置"
        description="处理账务。"
        headingId="finance-heading"
        descriptionId="finance-description"
      />,
    );

    expect(markup).not.toContain("ops-page-heading-actions");
    expect(markup).not.toContain("ops-conversation-step");
  });
});
