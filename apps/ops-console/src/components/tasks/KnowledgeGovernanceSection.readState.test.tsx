import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "antd";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { CompetitorAnalysis, KnowledgeAsset, LearningSuggestion, Rule } from "../../types/ops";
import { KnowledgeGovernanceSection, knowledgeLearningTabLabel, knowledgePendingTagPresentation, knowledgeStatisticValue } from "./KnowledgeGovernanceSection";
import { AssetRightsPanel } from "./knowledge/AssetRightsPanel";
import { CompetitorReferencesPanel } from "./knowledge/CompetitorReferencesPanel";
import { LearningSuggestionsPanel } from "./knowledge/LearningSuggestionsPanel";

const KNOWLEDGE_ERROR =
  "部分数据集刷新失败（knowledge.rule.list、knowledge.asset.list、knowledge.learning.list、knowledge.competitor.list）。页面保留上次成功数据，这些值可能已过期：数据库连接失败";

/** Text between tags, with icons dropped, so assertions read what the operator reads. */
function visibleText(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/gu, "")
    .replace(/<[^>]+>/gu, "|")
    .replace(/\|+/gu, "|");
}

type KnowledgeLists = {
  knowledgeRules?: Rule[];
  knowledgeAssets?: KnowledgeAsset[];
  learningSuggestions?: LearningSuggestion[];
  competitors?: CompetitorAnalysis[];
  error?: string;
};

function KnowledgeHarness({ lists }: { lists: KnowledgeLists }) {
  const [knowledgeRuleForm] = Form.useForm();
  const model = {
    ...lists,
    canRules: true,
    canKnowledge: true,
    createKnowledgeRule: vi.fn(),
    updateKnowledgeRule: vi.fn(),
    confirmLearning: vi.fn(),
    dismissLearning: vi.fn(),
    knowledgeRuleForm,
    dataSetError: () => lists.error,
  } as unknown as OpsConsoleModel;
  return <KnowledgeGovernanceSection model={model} />;
}

function PanelTables({
  assets,
  competitors,
}: {
  assets: KnowledgeAsset[] | undefined;
  competitors: CompetitorAnalysis[] | undefined;
}) {
  const [knowledgeAssetForm] = Form.useForm();
  const [competitorForm] = Form.useForm();
  return (
    <>
      <AssetRightsPanel model={{ knowledgeAssets: assets, knowledgeAssetForm, canKnowledge: false } as unknown as OpsConsoleModel} />
      <CompetitorReferencesPanel model={{ competitors, competitorForm, canCompetitor: false } as unknown as OpsConsoleModel} />
    </>
  );
}

describe("KnowledgeGovernanceSection read state", () => {
  // Regression: a failed knowledge read kept the model's `[]` seed, so the
  // section rendered a green 「0 条待处理建议」, four zeroed statistics, the
  // 「学习建议（0）」 tab and 「尚未录入工作区规则」 over four 500s — a page-level
  // OpsPageError contradicted by its own content.
  it("never renders a measured zero for a knowledge read that never landed", () => {
    const html = renderToStaticMarkup(
      <KnowledgeHarness lists={{ error: KNOWLEDGE_ERROR }} />,
    );
    const text = visibleText(html);

    expect(html).not.toContain("ant-tag-green");
    expect(html).toContain("待处理建议未读取（读取失败）");
    expect(text).toContain("工作区规则|—|待审核资产|—|竞品参考|—|待确认学习|—");
    expect(text).toContain("学习建议（未读取）");
    expect(text).toContain("工作区规则尚未读取");
    expect(text).not.toContain("0 条待处理建议");
    expect(text).not.toContain("尚未录入工作区规则");
    // The page-level banner already states the failure; the section must not
    // contradict it by claiming the knowledge base is simply empty.
    expect(text).not.toContain("|0|待审核资产|");
  });

  it("keeps the all-clear green only for reads that actually landed", () => {
    const html = renderToStaticMarkup(
      <KnowledgeHarness
        lists={{
          knowledgeRules: [],
          knowledgeAssets: [],
          learningSuggestions: [],
          competitors: [],
        }}
      />,
    );
    const text = visibleText(html);

    expect(html).toContain("ant-tag-green");
    expect(text).toContain("|0 条待处理建议|");
    expect(text).toContain("工作区规则|0|待审核资产|0|竞品参考|0|待确认学习|0");
    expect(text).toContain("学习建议（0）");
    expect(text).toContain("尚未录入工作区规则");
    expect(text).not.toContain("尚未读取");
    expect(text).not.toContain("—");
  });

  it("keeps the pending-work warning for read rows that need attention", () => {
    const html = renderToStaticMarkup(
      <KnowledgeHarness
        lists={{
          knowledgeRules: [],
          knowledgeAssets: [],
          learningSuggestions: [{ id: "s-1" } as unknown as LearningSuggestion],
          competitors: [],
        }}
      />,
    );
    expect(html).toContain("ant-tag-orange");
    expect(visibleText(html)).toContain("1 条待处理建议");
  });

  it("marks a count kept from an earlier read as no longer current", () => {
    const html = renderToStaticMarkup(
      <KnowledgeHarness
        lists={{
          knowledgeRules: [],
          knowledgeAssets: [],
          learningSuggestions: [{ id: "s-1" } as unknown as LearningSuggestion],
          competitors: [],
          error: KNOWLEDGE_ERROR,
        }}
      />,
    );
    expect(html).toContain("ant-tag-red");
    expect(visibleText(html)).toContain("1 条待处理建议（读取失败，可能已过期）");
  });

  // The section only server-renders its active tab, so each knowledge table
  // states its own read state.
  it("labels an unread learning table as unread, not as empty", () => {
    const unread = renderToStaticMarkup(
      <LearningSuggestionsPanel
        model={{ learningSuggestions: undefined, canKnowledge: false } as unknown as OpsConsoleModel}
      />,
    );
    expect(visibleText(unread)).toContain("学习建议尚未读取");
    expect(visibleText(unread)).not.toContain("当前没有待确认的学习建议");

    const empty = renderToStaticMarkup(
      <LearningSuggestionsPanel
        model={{ learningSuggestions: [], canKnowledge: false } as unknown as OpsConsoleModel}
      />,
    );
    expect(visibleText(empty)).toContain("当前没有待确认的学习建议");
    expect(visibleText(empty)).not.toContain("尚未读取");
  });

  it("does the same for the asset and competitor tables", () => {
    const unread = visibleText(renderToStaticMarkup(
      <PanelTables assets={undefined} competitors={undefined} />,
    ));
    expect(unread).toContain("知识资产尚未读取");
    expect(unread).toContain("竞品参考尚未读取");
    expect(unread).not.toContain("尚无知识资产");
    expect(unread).not.toContain("尚无合规竞品参考");

    const empty = visibleText(renderToStaticMarkup(
      <PanelTables assets={[]} competitors={[]} />,
    ));
    expect(empty).toContain("尚无知识资产");
    expect(empty).toContain("尚无合规竞品参考");
    expect(empty).not.toContain("尚未读取");
  });

  it("states the read state in the helper the tag and statistics are built from", () => {
    expect(knowledgeStatisticValue(undefined)).toBe("—");
    expect(knowledgeStatisticValue([])).toBe(0);
    expect(knowledgeStatisticValue([1, 2])).toBe(2);
    expect(knowledgeLearningTabLabel(undefined)).toBe("学习建议（未读取）");
    expect(knowledgeLearningTabLabel([])).toBe("学习建议（0）");
    expect(knowledgePendingTagPresentation({}).color).toBe("default");
    expect(knowledgePendingTagPresentation({ error: KNOWLEDGE_ERROR }).color).toBe("red");
  });
});
