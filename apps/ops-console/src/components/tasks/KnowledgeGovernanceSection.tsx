import { Alert, Card, Col, Row, Statistic, Tabs, Tag } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { AssetRightsPanel } from "./knowledge/AssetRightsPanel";
import { CompetitorReferencesPanel } from "./knowledge/CompetitorReferencesPanel";
import { KnowledgeRulesPanel } from "./knowledge/KnowledgeRulesPanel";
import { LearningSuggestionsPanel } from "./knowledge/LearningSuggestionsPanel";
import { BrandPreferencePanel } from "./knowledge/BrandPreferencePanel";

interface KnowledgeGovernanceSectionProps {
  model: OpsConsoleModel;
  title?: string;
}

/** The value a statistic shows when its dataset was never read. */
export const UNREAD_STATISTIC_VALUE = "—";

/**
 * Counts a knowledge dataset, or states that it was never read.
 *
 * A knowledge list is `undefined` until a read lands, so `0` is always a
 * measurement: the previous `?? []` seed made a failed `knowledge.learning.list`
 * render as a green 「0 条待处理建议」 next to four zeroed statistics.
 */
export function knowledgeStatisticValue(
  rows: readonly unknown[] | undefined,
): number | string {
  return rows === undefined ? UNREAD_STATISTIC_VALUE : rows.length;
}

export function knowledgeLearningTabLabel(
  rows: readonly unknown[] | undefined,
): string {
  return `学习建议（${rows === undefined ? "未读取" : rows.length}）`;
}

/**
 * What the pending-work tag is allowed to claim, following
 * `alertCountPresentation`: a failed or missing read is never a green
 * all-clear, and a count kept from an earlier successful read is marked as no
 * longer current instead of being reprinted as a fresh measurement.
 */
export function knowledgePendingTagPresentation({
  suggestionCount,
  pendingAssetCount,
  error,
}: {
  suggestionCount?: number;
  pendingAssetCount?: number;
  error?: string;
}): { color: "green" | "orange" | "red" | "default"; label: string } {
  if (suggestionCount === undefined) {
    return error
      ? { color: "red", label: "待处理建议未读取（读取失败）" }
      : { color: "default", label: "待处理建议未读取" };
  }
  if (error) {
    return {
      color: "red",
      label: `${suggestionCount} 条待处理建议（读取失败，可能已过期）`,
    };
  }
  // A green tag is an all-clear for the whole block, so it needs both counts
  // this section summarizes to have been read.
  const color = pendingAssetCount === undefined || suggestionCount || pendingAssetCount
    ? "orange"
    : "green";
  return { color, label: `${suggestionCount} 条待处理建议` };
}

export function KnowledgeGovernanceSection({
  model,
  title = "营销能力运营治理",
}: KnowledgeGovernanceSectionProps) {
  const {
    competitors,
    knowledgeAssets,
    knowledgeRules,
    learningSuggestions,
  } = model;
  const pendingAssetCount = knowledgeAssets?.filter(
    (item) =>
      item.approvalStatus !== "approved" || item.rightsStatus !== "cleared",
  ).length;
  const pendingTag = knowledgePendingTagPresentation({
    suggestionCount: learningSuggestions?.length,
    pendingAssetCount,
    error: model.dataSetError(
      "knowledge.rule.list",
      "knowledge.asset.list",
      "knowledge.learning.list",
      "knowledge.competitor.list",
    ),
  });

  return (
    <Card
      id="ops-domain-tasks"
      className="ops-section-anchor"
      title={title}
      extra={
        <Tag color={pendingTag.color}>
          {pendingTag.label}
        </Tag>
      }
    >
      <Alert
        type="info"
        showIcon
        title="这里维护当前工作区的运营规则与经验，不是平台官方规则。平台规则按京东、淘宝、天猫、拼多多、小红书、抖音分别同步，请前往“平台规则”查看新鲜度并更新。"
        style={{ marginBottom: 16 }}
      />
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Statistic title="工作区规则" value={knowledgeStatisticValue(knowledgeRules)} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="待审核资产"
            value={pendingAssetCount === undefined ? UNREAD_STATISTIC_VALUE : pendingAssetCount}
          />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="竞品参考" value={knowledgeStatisticValue(competitors)} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="待确认学习" value={knowledgeStatisticValue(learningSuggestions)} />
        </Col>
      </Row>
      <Tabs
        items={[
          {
            key: "knowledge",
            label: "工作区规则",
            children: <KnowledgeRulesPanel model={model} />,
          },
          {
            key: "assets",
            label: "资产权益",
            children: <AssetRightsPanel model={model} />,
          },
          {
            key: "preferences",
            label: "品牌偏好",
            children: <BrandPreferencePanel model={model} />,
          },
          {
            key: "learning",
            label: knowledgeLearningTabLabel(learningSuggestions),
            children: <LearningSuggestionsPanel model={model} />,
          },
          {
            key: "competitors",
            label: "竞品参考",
            children: <CompetitorReferencesPanel model={model} />,
          },
        ]}
      />
      <Alert
        type="info"
        showIcon
        title="运营确认学习建议只记录人工判断，不会自动激活全局规则；未确认资产和权利不明竞品不得进入商家正式发布链路。"
      />
    </Card>
  );
}
