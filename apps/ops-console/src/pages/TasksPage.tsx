import { ProductSpreadsheetImport } from '../components/stores/ProductSpreadsheetImport.js';
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AlertFiltersSection } from "../components/tasks/AlertFiltersSection";
import { MarketingQueueFiltersSection } from "../components/tasks/MarketingQueueFiltersSection";
import { OperationalGovernanceSection } from "../components/tasks/OperationalGovernanceSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { Alert, Button, Card, Col, Row, Statistic } from "antd";
import { useEffect, useRef } from "react";
import { platforms, type Platform, type StoreDirectory } from "../types/ops.js";
interface TasksPageProps {
  model: OpsConsoleModel;
}

export function TasksPage({ model }: TasksPageProps) {
  const appliedQueryKey = useRef("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get("task_id")?.trim();
    const requestedPlatform = params.get("platform")?.trim();
    const requestedAccountId = params.get("accountId")?.trim();
    const hasStoreQuery = params.has("platform") || params.has("accountId");
    const scope = model.authorization.scope;
    const scopeKey = `${scope.kind}:${scope.id ?? ""}:${model.opsSession?.workspace_id ?? ""}`;
    const queryKey = `${scopeKey}|${window.location.search}`;
    if (!taskId && !hasStoreQuery) return;
    if (appliedQueryKey.current === queryKey) return;
    // The initial bootstrap load also hydrates the authorized store directory.
    // Wait for it before resolving an account deep link so an arbitrary query
    // value can never become the active account filter.
    if (hasStoreQuery && model.loading) return;

    let storeFilters: Pick<typeof model.queueFilters, "platform" | "accountId"> = {};
    if (hasStoreQuery && requestedPlatform && requestedAccountId &&
      platforms.includes(requestedPlatform as Platform) && scope.kind === "workspace" &&
      (!model.opsSession?.workspace_id || model.opsSession.workspace_id === scope.id)) {
      const authorizedStore = model.storeDirectory.some((store: StoreDirectory) =>
        store.platform === requestedPlatform && store.accountId === requestedAccountId &&
        (!store.workspaceId || store.workspaceId === scope.id),
      );
      if (authorizedStore) storeFilters = { platform: requestedPlatform as Platform, accountId: requestedAccountId };
    }
    const baseFilters = hasStoreQuery
      ? { ...model.queueFilters, platform: undefined, accountId: undefined }
      : model.queueFilters;
    const queueFilters = {
      ...baseFilters,
      ...storeFilters,
      ...(taskId ? { taskId } : {}),
    };
    appliedQueryKey.current = queryKey;
    model.setQueueFilters(queueFilters);
    void model.load({ queueFilters });
    // A store deep link is only meaningful when it resolves inside the
    // current workspace's authorized directory. Remove rejected parameters
    // from the address bar so a copied or refreshed URL does not keep
    // promising a filter that was never applied. Preserve unrelated context.
    if (hasStoreQuery && Object.keys(storeFilters).length === 0) {
      params.delete("platform");
      params.delete("accountId");
      const query = params.toString();
      const normalizedUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", normalizedUrl);
      appliedQueryKey.current = `${scopeKey}|${query ? `?${query}` : ""}`;
    }
  }, [model.authorization.scope, model.loading, model.opsSession?.workspace_id, model.queueFilters, model.setQueueFilters, model.load, model.storeDirectory]);
  const canReadPlatformTasks = model.authorization.can("workspace.directory.read");
  const canReadPlatformMarketing = model.authorization.can("marketing.summary.read");
  const canReadMarketingQueue = model.authorization.can("marketing.queue.read");
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
              <span className="ops-tasks-scope-note">汇总范围：当前授权企业主体</span>
            </div>
            <div className="ops-tasks-summary-grid">
              {canReadPlatformTasks && model.platformTaskSummary ? (
                <Card className="ops-tasks-summary-card" title="任务处理量" size="small">
                  <Row gutter={[12, 12]}>
                    <Col span={6}><Statistic title="企业主体" value={model.platformTaskSummary.workspaceCount} /></Col>
                    <Col span={6}><Statistic title="全部任务" value={model.platformTaskSummary.taskCount} /></Col>
                    <Col span={6}><Statistic title="生成中" value={model.platformTaskSummary.generationQueueCount} /></Col>
                    <Col span={6}><Statistic title="待发布" value={model.platformTaskSummary.publishQueueCount} /></Col>
                  </Row>
                  {model.platformTaskSummary.failedWorkspaceCount ? <Alert className="ops-tasks-inline-alert" type="warning" showIcon title={`${model.platformTaskSummary.failedWorkspaceCount} 个企业主体任务数据暂未纳入汇总`} /> : null}
                </Card>
              ) : null}
              {canReadPlatformMarketing && model.platformMarketingSummary ? (
                <Card className="ops-tasks-summary-card" title="内容治理量" size="small">
                  <Row gutter={[12, 12]}>
                    <Col span={6}><Statistic title="待审视觉" value={model.platformMarketingSummary.visualReviewCount} /></Col>
                    <Col span={6}><Statistic title="素材风险" value={model.platformMarketingSummary.assetRiskCount} /></Col>
                    <Col span={6}><Statistic title="学习建议" value={model.platformMarketingSummary.learningSuggestionCount} /></Col>
                    <Col span={6}><Statistic title="生成失败" value={model.platformMarketingSummary.generationByState.failed ?? 0} /></Col>
                    <Col span={6}><Statistic title="视频待对账" value={model.platformMarketingSummary.videoPendingReconciliationCount} /></Col>
                    <Col span={6}><Statistic title="视频归档风险" value={model.platformMarketingSummary.videoArchiveRiskCount} /></Col>
                  </Row>
                  {model.platformMarketingSummary.failedWorkspaceCount ? <Alert className="ops-tasks-inline-alert" type="warning" showIcon title={`${model.platformMarketingSummary.failedWorkspaceCount} 个企业主体营销数据暂未纳入汇总`} /> : null}
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
            description="平台运营可以处理平台级告警与治理任务；客户商品、素材、生成和发布内容需要对应企业主体成员权限或临时授权。空列表不代表没有客户任务。"
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
            {canReadMarketingQueue ? <MarketingQueueFiltersSection model={model} /> : null}
            {canReadPlatformMarketing ? <AlertFiltersSection model={model} /> : null}
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
            <Alert className="ops-tasks-access-note" showIcon type="info" title="平台运营使用聚合治理数据" description="客户商品、素材、知识和内容队列属于企业主体范围；平台运营台只展示跨企业主体的任务、视觉审核、素材风险和学习建议汇总。需要处理具体内容时，请进入对应企业主体的授权运营会话。" />
          ) : canReadCustomerContent ? <OperationalGovernanceSection model={model} /> : null}
        </section></div>
    </OpsPage>
  );
}
