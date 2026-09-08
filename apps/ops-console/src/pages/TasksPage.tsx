import { ProductSpreadsheetImport } from '../components/stores/ProductSpreadsheetImport.js';
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AlertFiltersSection } from "../components/tasks/AlertFiltersSection";
import { MarketingQueueFiltersSection } from "../components/tasks/MarketingQueueFiltersSection";
import { OperationalGovernanceSection } from "../components/tasks/OperationalGovernanceSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { Alert, Button, Card, Col, Row, Statistic } from "antd";
import { useEffect } from "react";
interface TasksPageProps {
  model: OpsConsoleModel;
}

export function TasksPage({ model }: TasksPageProps) {
  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get("task_id")?.trim();
    if (!taskId) return;
    const queueFilters = { ...model.queueFilters, taskId };
    model.setQueueFilters(queueFilters);
    void model.load({ queueFilters });
  }, []);
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
      description="导入客户商品与 SKU，管理素材、生成任务和发布异常。"
      actions={<Button type="primary" loading={model.loading} onClick={() => void model.load()}>刷新任务</Button>}
      nextStep={taskError ? "先修复数据读取问题并重试；空列表不能解释为没有任务。" : "先查看需要处理的任务，再进入素材、规则或发布异常的对应处置。"}
    >
      <div className="ops-tasks-page">
        <OpsPageError error={taskError ?? ""} onRetry={() => void model.load()} />
        {(canReadPlatformTasks && model.platformTaskSummary) || (canReadPlatformMarketing && model.platformMarketingSummary) ? (
          <section className="ops-tasks-overview" aria-labelledby="ops-tasks-overview-title">
            <div className="ops-tasks-section-heading">
              <div>
                <span className="ops-tasks-section-kicker">WORK QUEUE</span>
                <h2 id="ops-tasks-overview-title">今天先处理什么</h2>
              </div>
              <span className="ops-tasks-scope-note">汇总范围：当前授权工作区</span>
            </div>
            <div className="ops-tasks-summary-grid">
              {canReadPlatformTasks && model.platformTaskSummary ? (
                <Card className="ops-tasks-summary-card" title="任务处理量" size="small">
                  <Row gutter={[12, 12]}>
                    <Col span={6}><Statistic title="工作区" value={model.platformTaskSummary.workspaceCount} /></Col>
                    <Col span={6}><Statistic title="全部任务" value={model.platformTaskSummary.taskCount} /></Col>
                    <Col span={6}><Statistic title="生成中" value={model.platformTaskSummary.generationQueueCount} /></Col>
                    <Col span={6}><Statistic title="待发布" value={model.platformTaskSummary.publishQueueCount} /></Col>
                  </Row>
                  {model.platformTaskSummary.failedWorkspaceCount ? <Alert className="ops-tasks-inline-alert" type="warning" showIcon title={`${model.platformTaskSummary.failedWorkspaceCount} 个工作区任务数据暂未纳入汇总`} /> : null}
                </Card>
              ) : null}
              {canReadPlatformMarketing && model.platformMarketingSummary ? (
                <Card className="ops-tasks-summary-card" title="内容治理量" size="small">
                  <Row gutter={[12, 12]}>
                    <Col span={6}><Statistic title="待审视觉" value={model.platformMarketingSummary.visualReviewCount} /></Col>
                    <Col span={6}><Statistic title="素材风险" value={model.platformMarketingSummary.assetRiskCount} /></Col>
                    <Col span={6}><Statistic title="学习建议" value={model.platformMarketingSummary.learningSuggestionCount} /></Col>
                    <Col span={6}><Statistic title="生成失败" value={model.platformMarketingSummary.generationByState.failed ?? 0} /></Col>
                  </Row>
                  {model.platformMarketingSummary.failedWorkspaceCount ? <Alert className="ops-tasks-inline-alert" type="warning" showIcon title={`${model.platformMarketingSummary.failedWorkspaceCount} 个工作区营销数据暂未纳入汇总`} /> : null}
                </Card>
              ) : null}
            </div>
          </section>
        ) : null}
        {!model.canQueue && canReadPlatformMarketing ? (
          <Alert
            className="ops-tasks-access-note"
            showIcon
            type="info"
            title="客户内容队列受控"
            description="平台运营可以处理平台级告警与治理任务；客户商品、素材、生成和发布内容需要对应工作区成员权限或临时授权。空列表不代表没有客户任务。"
          />
        ) : null}
        <section className="ops-tasks-work" aria-labelledby="ops-tasks-work-title">
          <div className="ops-tasks-section-heading">
            <div>
              <span className="ops-tasks-section-kicker">ACTION CENTER</span>
              <h2 id="ops-tasks-work-title">待处理队列</h2>
            </div>
            <span className="ops-tasks-section-description">先筛选范围，再处理任务或告警</span>
          </div>
          <div className="ops-tasks-filter-grid">
            <MarketingQueueFiltersSection model={model} />
            <AlertFiltersSection model={model} />
          </div>
        </section>

        <section className="ops-tasks-input" aria-labelledby="ops-tasks-input-title">
          <div className="ops-tasks-section-heading">
            <div>
              <span className="ops-tasks-section-kicker">DATA &amp; GOVERNANCE</span>
              <h2 id="ops-tasks-input-title">数据输入与治理</h2>
            </div>
            <span className="ops-tasks-section-description">导入商品后，再进入素材和交付治理</span>
          </div>
          <ProductSpreadsheetImport key={model.opsSession?.workspace_id ?? "platform"} workspaceId={model.opsSession?.workspace_id} platformScope={model.authorization.scope.kind === "platform"} canWrite={model.authorization.can("customer.content.update")} />
          {!canReadCustomerContent && canReadPlatformMarketing ? (
            <Alert className="ops-tasks-access-note" showIcon type="info" title="平台运营使用聚合治理数据" description="客户商品、素材、知识和内容队列属于工作区范围；平台运营台只展示跨工作区的任务、视觉审核、素材风险和学习建议汇总。需要处理具体内容时，请进入对应工作区的授权运营会话。" />
          ) : canReadCustomerContent ? <OperationalGovernanceSection model={model} /> : null}
        </section></div>
    </OpsPage>
  );
}
