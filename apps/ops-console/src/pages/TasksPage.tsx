import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AlertFiltersSection } from "../components/tasks/AlertFiltersSection";
import { KnowledgeGovernanceSection } from "../components/tasks/KnowledgeGovernanceSection";
import { MarketingQueueFiltersSection } from "../components/tasks/MarketingQueueFiltersSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { Alert, Card, Col, Row, Statistic } from "antd";

interface TasksPageProps {
  model: OpsConsoleModel;
}

export function TasksPage({ model }: TasksPageProps) {
  const canReadPlatformTasks = model.authorization.can("workspace.directory.read");
  const canReadPlatformMarketing = model.authorization.can("marketing.summary.read");
  const canReadCustomerContent = model.authorization.canAny(["marketing.queue.read", "customer.content.read"]);
  const taskError = model.dataSetError(
    "ops.alerts.list",
    "knowledge.rule.list",
    "knowledge.asset.list",
    "knowledge.learning.list",
    "knowledge.competitor.list",
    "ops.marketing.queue",
    "ops.marketing.summary",
    "ops.tasks.summary",
  );
  return (
    <OpsPage
      eyebrow="CONTENT OPERATIONS"
      title="任务与内容"
      description="治理知识、素材、生成任务和发布异常；平台规则在独立规则中心维护。"
      nextStep={taskError ? "先修复数据读取问题并重试；空列表不能解释为没有任务。" : "先查看需要处理的任务，再进入素材、规则或发布异常的对应处置。"}
    >
      <OpsPageError error={taskError ?? ""} onRetry={() => void model.load()} />
      {canReadPlatformTasks && model.platformTaskSummary ? (
        <Card title="平台任务汇总" size="small">
          <Row gutter={[16, 16]}>
            <Col span={6}><Statistic title="工作区" value={model.platformTaskSummary.workspaceCount} /></Col>
            <Col span={6}><Statistic title="任务总数" value={model.platformTaskSummary.taskCount} /></Col>
            <Col span={6}><Statistic title="生成队列" value={model.platformTaskSummary.generationQueueCount} /></Col>
            <Col span={6}><Statistic title="发布队列" value={model.platformTaskSummary.publishQueueCount} /></Col>
          </Row>
          {model.platformTaskSummary.failedWorkspaceCount ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title={`${model.platformTaskSummary.failedWorkspaceCount} 个工作区任务数据暂未纳入汇总`} /> : null}
        </Card>
      ) : null}
      {canReadPlatformMarketing && model.platformMarketingSummary ? (
        <Card title="平台营销治理汇总" size="small" style={{ marginTop: 16 }}>
          <Row gutter={[16, 16]}>
            <Col span={6}><Statistic title="待审视觉" value={model.platformMarketingSummary.visualReviewCount} /></Col>
            <Col span={6}><Statistic title="素材风险" value={model.platformMarketingSummary.assetRiskCount} /></Col>
            <Col span={6}><Statistic title="待处理学习建议" value={model.platformMarketingSummary.learningSuggestionCount} /></Col>
            <Col span={6}><Statistic title="生成失败" value={model.platformMarketingSummary.generationByState.failed ?? 0} /></Col>
          </Row>
          {model.platformMarketingSummary.failedWorkspaceCount ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title={`${model.platformMarketingSummary.failedWorkspaceCount} 个工作区营销数据暂未纳入汇总`} /> : null}
        </Card>
      ) : null}
      {!model.canQueue && canReadPlatformMarketing ? (
        <Alert
          showIcon
          type="info"
          title="客户内容队列受控"
          description="平台运营可以处理平台级告警与治理任务；客户商品、素材、生成和发布内容需要对应工作区成员权限或临时授权。空列表不代表没有客户任务。"
        />
      ) : null}
      <MarketingQueueFiltersSection model={model} />
      <AlertFiltersSection model={model} />
      {!canReadCustomerContent && canReadPlatformMarketing ? (
        <Alert
          showIcon
          type="info"
          style={{ marginTop: 16 }}
          title="平台运营使用聚合治理数据"
          description="客户商品、素材、知识和内容队列属于工作区范围；平台运营台只展示跨工作区的任务、视觉审核、素材风险和学习建议汇总。需要处理具体内容时，请进入对应工作区的授权运营会话。"
        />
      ) : canReadCustomerContent ? <KnowledgeGovernanceSection model={model} /> : null}
    </OpsPage>
  );
}
