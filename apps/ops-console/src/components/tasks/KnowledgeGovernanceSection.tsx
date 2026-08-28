import { Alert, Card, Col, Row, Statistic, Tabs, Tag } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { AssetRightsPanel } from "./knowledge/AssetRightsPanel";
import { CompetitorReferencesPanel } from "./knowledge/CompetitorReferencesPanel";
import { KnowledgeRulesPanel } from "./knowledge/KnowledgeRulesPanel";
import { LearningSuggestionsPanel } from "./knowledge/LearningSuggestionsPanel";
import { MarketingQueuePanel } from "./knowledge/MarketingQueuePanel";
import { UploadedAssetGovernance } from "./knowledge/UploadedAssetGovernance";

interface KnowledgeGovernanceSectionProps {
  model: OpsConsoleModel;
}

export function KnowledgeGovernanceSection({
  model,
}: KnowledgeGovernanceSectionProps) {
  const {
    competitors,
    knowledgeAssets,
    knowledgeRules,
    learningSuggestions,
    marketingQueue,
    workspaceMetrics,
  } = model;
  const pendingAssetCount = knowledgeAssets.filter(
    (item) =>
      item.approvalStatus !== "approved" || item.rightsStatus !== "cleared",
  ).length;
  const queueCount =
    marketingQueue.generation.length +
    marketingQueue.publish.length +
    marketingQueue.visuals.length +
    marketingQueue.batches.length +
    marketingQueue.uploadedAssetRisks.length;

  return (
    <Card
      id="ops-domain-tasks"
      className="ops-section-anchor"
      title="营销能力运营治理"
      extra={
        <Tag
          color={
            learningSuggestions.length || pendingAssetCount ? "orange" : "green"
          }
        >
          {learningSuggestions.length} 条待处理建议
        </Tag>
      }
    >
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Statistic title="知识规则" value={knowledgeRules.length} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="待审核资产" value={pendingAssetCount} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="竞品参考" value={competitors.length} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="生成失败"
            value={workspaceMetrics?.jobs?.generationFailed ?? 0}
          />
        </Col>
      </Row>
      <Tabs
        items={[
          {
            key: "knowledge",
            label: "知识规则",
            children: <KnowledgeRulesPanel model={model} />,
          },
          {
            key: "assets",
            label: "资产权益",
            children: <AssetRightsPanel model={model} />,
          },
          {
            key: "learning",
            label: `学习建议（${learningSuggestions.length}）`,
            children: <LearningSuggestionsPanel model={model} />,
          },
          {
            key: "competitors",
            label: "竞品参考",
            children: <CompetitorReferencesPanel model={model} />,
          },
          {
            key: "queue",
            label: `任务队列（${queueCount}）`,
            children: <MarketingQueuePanel model={model} />,
          },
        ]}
      />
      <UploadedAssetGovernance model={model} />
      <Alert
        type="info"
        showIcon
        title="运营确认学习建议只记录人工判断，不会自动激活全局规则；未确认资产和权利不明竞品不得进入商家正式发布链路。"
      />
    </Card>
  );
}
