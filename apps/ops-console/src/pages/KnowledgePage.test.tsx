import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";

vi.mock("../components/tasks/KnowledgeGovernanceSection", () => ({
  KnowledgeGovernanceSection: ({ title }: { title?: string }) =>
    createElement("div", { "data-testid": "knowledge-governance" }, title),
}));

import { KnowledgePage } from "./KnowledgePage.js";

function knowledgeModel(error?: string) {
  return {
    dataSetError: (...methods: string[]) => methods.includes("knowledge.learning.list") ? error : undefined,
    loading: false,
    load: vi.fn(async () => undefined),
  } as unknown as OpsConsoleModel;
}

describe("KnowledgePage", () => {
  it("renders the knowledge title and explains the human-confirmed learning loop", () => {
    const html = renderToStaticMarkup(<KnowledgePage model={knowledgeModel()} />);

    expect(html).toContain("知识库");
    expect(html).toContain("插件学习闭环已接入");
    expect(html).toContain("反馈会先进入学习建议，人工确认后才会影响后续生成。");
  });

  it("surfaces a dataset read error, its retry path, and the governance section", async () => {
    const model = knowledgeModel("知识学习数据集读取失败");
    const html = renderToStaticMarkup(<KnowledgePage model={model} />);

    expect(html).toContain("知识学习数据集读取失败");
    expect(html).toContain("先修复知识数据读取问题；空列表不能解释为知识库没有内容。");
    expect(html).toContain('aria-label="重试加载运营数据"');
    expect(html).toContain('data-testid="knowledge-governance"');
    expect(html).toContain("知识库内容与治理");

    const pageElement = KnowledgePage({ model });
    const pageChildren = pageElement.props.children;
    if (!isValidElement<{ children: ReactNode }>(pageChildren)) {
      throw new Error("KnowledgePage did not render its OpsPage content");
    }
    const errorElement = Children.toArray(pageChildren.props.children)[0];
    if (!isValidElement<{ onRetry?: () => void }>(errorElement) || !errorElement.props.onRetry) {
      throw new Error("KnowledgePage did not connect the dataset error retry action");
    }
    await errorElement.props.onRetry();
    expect(model.load).toHaveBeenCalledOnce();
  });
});
