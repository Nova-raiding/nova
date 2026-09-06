import { Alert, Button, Card, Col, Row, Statistic, Typography } from "antd";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { KnowledgeGovernanceSection } from "../components/tasks/KnowledgeGovernanceSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface KnowledgePageProps {
  model: OpsConsoleModel;
}

/** The knowledge base is a first-class workspace surface, not a task sub-panel. */
export function KnowledgePage({ model }: KnowledgePageProps) {
  const error = model.dataSetError(
    "knowledge.rule.list",
    "knowledge.asset.list",
    "knowledge.learning.list",
    "knowledge.competitor.list",
  );
  const pendingAssets = model.knowledgeAssets.filter(
    (asset) => asset.approvalStatus !== "approved" || asset.rightsStatus !== "cleared",
  ).length;

  return (
    <OpsPage
      eyebrow="WORKSPACE KNOWLEDGE"
      title="知识库"
      description="把已核验的品牌资产、运营规则、人工反馈和竞品观察沉淀为可追溯的工作区记忆，并安全提供给 ChatGPT 插件使用。"
      actions={<Button type="primary" loading={model.loading} onClick={() => void model.load()}>刷新知识库</Button>}
      nextStep={error ? "先修复知识数据读取问题；空列表不能解释为知识库没有内容。" : "先处理待审核资产，再确认规则和学习建议，最后让插件在下一次任务中引用已确认知识。"}
    >
      <OpsPageError error={error ?? ""} onRetry={() => void model.load()} />
      <Card className="knowledge-intro-card" style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>让每次确认都变成下一次的更好结果</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          插件只读取当前工作区、已确认且有来源的知识；发布驳回和人工反馈会先生成学习建议，必须由运营人员确认后才会进入后续生成上下文。未经审核的素材、权益不明内容和竞品原文不会被模型使用。
        </Typography.Paragraph>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}><Statistic title="知识规则" value={model.knowledgeRules.length} /></Col>
          <Col xs={12} md={6}><Statistic title="知识资产" value={model.knowledgeAssets.length} /></Col>
          <Col xs={12} md={6}><Statistic title="待审核资产" value={pendingAssets} /></Col>
          <Col xs={12} md={6}><Statistic title="待确认学习" value={model.learningSuggestions.length} /></Col>
        </Row>
      </Card>
      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 16 }}
        title="插件学习闭环已接入"
        description="知识库内容会按工作区隔离、来源和版本冻结；插件只拿到商家可见的安全摘要，不会暴露运营角色、内部 ID、原始素材或跨工作区数据。"
      />
      <KnowledgeGovernanceSection model={model} title="知识库内容与治理" />
    </OpsPage>
  );
}
