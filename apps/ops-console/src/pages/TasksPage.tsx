import { ProductSpreadsheetImport } from '../components/stores/ProductSpreadsheetImport.js';
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AlertFiltersSection } from "../components/tasks/AlertFiltersSection";
import { MarketingQueueFiltersSection } from "../components/tasks/MarketingQueueFiltersSection";
import { OperationalGovernanceSection } from "../components/tasks/OperationalGovernanceSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { Alert, Button, Card, Col, Row, Statistic } from "antd";
import { useEffect, useRef, useState } from "react";
import { platforms, type Platform, type QueueFilters, type StoreDirectory } from "../types/ops.js";
interface TasksPageProps {
  model: OpsConsoleModel;
}

export function TasksPage({ model }: TasksPageProps) {
  const appliedQueryKey = useRef("");
  const urlManagedFilters = useRef<QueueFilters>({});
  const [locationSearch, setLocationSearch] = useState(() =>
    typeof window === "undefined" ? "" : window.location.search,
  );
  const [storeFilterNotice, setStoreFilterNotice] = useState("");
  useEffect(() => {
    const updateSearch = () => setLocationSearch(window.location.search);
    window.addEventListener("popstate", updateSearch);
    window.addEventListener("hashchange", updateSearch);
    return () => {
      window.removeEventListener("popstate", updateSearch);
      window.removeEventListener("hashchange", updateSearch);
    };
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(locationSearch);
    const taskId = params.get("task_id")?.trim();
    const productId = (params.get("product_id") ?? params.get("productId"))?.trim();
    const state = params.get("state")?.trim();
    const requestedPlatform = params.get("platform")?.trim();
    const requestedAccountId = params.get("accountId")?.trim();
    const hasStoreQuery = params.has("platform") || params.has("accountId");
    const scope = model.authorization.scope;
    const scopeKey = `${scope.kind}:${scope.id ?? ""}:${model.opsSession?.workspace_id ?? ""}`;
    const queryKey = `${scopeKey}|${locationSearch}`;
    if (!taskId && !productId && !state && !hasStoreQuery && Object.keys(urlManagedFilters.current).length === 0) return;
    if (appliedQueryKey.current === queryKey) return;
    // The initial bootstrap load also hydrates the authorized store directory.
    // Wait for it before resolving an account deep link so an arbitrary query
    // value can never become the active account filter.
    if (hasStoreQuery && model.loading) return;

    setStoreFilterNotice("");

    let storeFilters: Pick<typeof model.queueFilters, "platform" | "accountId"> = {};
    const validWorkspaceStoreScope = scope.kind === "workspace" &&
      (!model.opsSession?.workspace_id || model.opsSession.workspace_id === scope.id);
    const validPlatform = requestedPlatform && platforms.includes(requestedPlatform as Platform);
    if (hasStoreQuery && validWorkspaceStoreScope && validPlatform) {
      storeFilters = { platform: requestedPlatform as Platform };
      if (requestedAccountId) {
        const authorizedStore = model.storeDirectory.some((store: StoreDirectory) =>
          store.platform === requestedPlatform && store.accountId === requestedAccountId &&
          (!store.workspaceId || store.workspaceId === scope.id),
        );
        if (authorizedStore) storeFilters.accountId = requestedAccountId;
      }
    } else if (hasStoreQuery && validWorkspaceStoreScope && !requestedPlatform && requestedAccountId) {
      // The queue selector supports account-only filters. Resolve that deep link
      // only when the current workspace directory identifies exactly one store;
      // an account ID that is absent or ambiguous must not select another scope.
      const matchingStores = model.storeDirectory.filter((store: StoreDirectory) =>
        store.accountId === requestedAccountId &&
        (!store.workspaceId || store.workspaceId === scope.id),
      );
      if (matchingStores.length === 1) storeFilters.accountId = requestedAccountId;
    }
    // Platform and account were issued as one store deep link. If the
    // authorized store directory is empty, discard the whole link. Otherwise
    // keep the safe platform-only filter while dropping an unresolved account
    // identifier; the directory itself is still available to scope the queue.
    if (requestedAccountId && !storeFilters.accountId) {
      if (model.storeDirectory.length === 0) storeFilters = {};
    }
    const nextUrlFilters: QueueFilters = {
      ...storeFilters,
      ...(taskId ? { taskId } : {}),
      ...(productId ? { productId } : {}),
      ...(state ? { state } : {}),
    };
    const queueFilters: QueueFilters = { ...model.queueFilters };
    // Remove a value only when it is still the value previously injected by
    // the URL. A user's later manual edit remains theirs when navigating back.
    for (const key of Object.keys(urlManagedFilters.current) as Array<keyof QueueFilters>) {
      if (!(key in nextUrlFilters) && queueFilters[key] === urlManagedFilters.current[key]) {
        delete queueFilters[key];
      }
    }
    Object.assign(queueFilters, nextUrlFilters);
    urlManagedFilters.current = nextUrlFilters;
    appliedQueryKey.current = queryKey;
    model.setQueueFilters(queueFilters);
    void model.load({ queueFilters });
    // A store deep link is only meaningful when it resolves inside the
    // current workspace's authorized directory. Remove rejected parameters
    // from the address bar so a copied or refreshed URL does not keep
    // promising a filter that was never applied. Preserve unrelated context.
    if (hasStoreQuery && (storeFilters.platform !== requestedPlatform || storeFilters.accountId !== requestedAccountId)) {
      setStoreFilterNotice("链接中的店铺筛选无法在当前授权工作区的店铺目录中确认，已移除店铺参数。请重新选择店铺后再处理队列。");
      if (storeFilters.platform) params.set("platform", storeFilters.platform);
      else params.delete("platform");
      if (storeFilters.accountId) params.set("accountId", storeFilters.accountId);
      else params.delete("accountId");
      const query = params.toString();
      const normalizedUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", normalizedUrl);
      const normalizedSearch = query ? `?${query}` : "";
      appliedQueryKey.current = `${scopeKey}|${normalizedSearch}`;
      setLocationSearch(normalizedSearch);
    }
  }, [locationSearch, model.authorization.scope, model.loading, model.opsSession?.workspace_id, model.queueFilters, model.setQueueFilters, model.load, model.storeDirectory]);
  const clearQueueFilters = () => {
    const params = new URLSearchParams(window.location.search);
    for (const key of ["platform", "accountId", "product_id", "productId", "task_id", "state"]) {
      params.delete(key);
    }
    const query = params.toString();
    const search = query ? `?${query}` : "";
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    setLocationSearch(search);
    const scope = model.authorization.scope;
    appliedQueryKey.current = `${scope.kind}:${scope.id ?? ""}:${model.opsSession?.workspace_id ?? ""}|${search}`;
    urlManagedFilters.current = {};
    model.setQueueFilters({});
    void model.load({ queueFilters: {} });
  };
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
  // Failed refreshes retain the previous hook value for recovery. It is not
  // current workload evidence, and test data must never establish real totals.
  const fixtureSummary = model.dataSource?.fixtureDataPresent === true;
  const taskSummary = fixtureSummary || model.dataSetError("ops.tasks.summary")
    ? undefined : model.platformTaskSummary;
  const marketingSummary = fixtureSummary || model.dataSetError("ops.marketing.summary")
    ? undefined : model.platformMarketingSummary;
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
        {fixtureSummary ? <Alert type="warning" showIcon title="任务汇总尚未核验" description="当前数据来源不能作为真实工作量依据，汇总数字暂不展示。请刷新并核实工作区数据源。" /> : null}
        {!fixtureSummary && !model.loading && !taskError && (canReadPlatformTasks || canReadPlatformMarketing) && !taskSummary && !marketingSummary ? <Alert type="info" showIcon title="任务汇总尚未返回" description="当前没有可展示的有效汇总，不能据此判断没有任务。" action={<Button onClick={() => void model.load()}>重新读取汇总</Button>} /> : null}
        {storeFilterNotice ? <Alert className="ops-tasks-access-note" showIcon closable onClose={() => setStoreFilterNotice("")} type="warning" title="店铺筛选未应用" description={storeFilterNotice} role="status" /> : null}
        {(canReadPlatformTasks && taskSummary) || (canReadPlatformMarketing && marketingSummary) ? (
          <section className="ops-tasks-overview" aria-labelledby="ops-tasks-overview-title">
            <div className="ops-tasks-section-heading">
              <div>
                <span className="ops-tasks-section-kicker">WORK QUEUE</span>
                <h2 id="ops-tasks-overview-title">今天先处理什么</h2>
              </div>
              <span className="ops-tasks-scope-note">汇总范围：当前授权企业主体</span>
            </div>
            <div className="ops-tasks-summary-grid">
              {canReadPlatformTasks && taskSummary ? (
                <Card className="ops-tasks-summary-card" title="任务处理量" size="small">
                  <Row gutter={[12, 12]}>
                    <Col span={6}><Statistic title="企业主体" value={taskSummary.workspaceCount} /></Col>
                    <Col span={6}><Statistic title="全部任务" value={taskSummary.taskCount} /></Col>
                    <Col span={6}><Statistic title="生成中" value={taskSummary.generationQueueCount} /></Col>
                    <Col span={6}><Statistic title="待发布" value={taskSummary.publishQueueCount} /></Col>
                  </Row>
                  {taskSummary.failedWorkspaceCount ? <Alert className="ops-tasks-inline-alert" type="warning" showIcon title={`${taskSummary.failedWorkspaceCount} 个企业主体任务数据暂未纳入汇总`} /> : null}
                </Card>
              ) : null}
              {canReadPlatformMarketing && marketingSummary ? (
                <Card className="ops-tasks-summary-card" title="内容治理量" size="small">
                  <Row gutter={[12, 12]}>
                    <Col span={6}><Statistic title="待审视觉" value={marketingSummary.visualReviewCount} /></Col>
                    <Col span={6}><Statistic title="素材风险" value={marketingSummary.assetRiskCount} /></Col>
                    <Col span={6}><Statistic title="学习建议" value={marketingSummary.learningSuggestionCount} /></Col>
                    <Col span={6}><Statistic title="生成失败" value={marketingSummary.generationByState.failed ?? 0} /></Col>
                    <Col span={6}><Statistic title="视频待对账" value={marketingSummary.videoPendingReconciliationCount} /></Col>
                    <Col span={6}><Statistic title="视频归档风险" value={marketingSummary.videoArchiveRiskCount} /></Col>
                  </Row>
                  {marketingSummary.failedWorkspaceCount ? <Alert className="ops-tasks-inline-alert" type="warning" showIcon title={`${marketingSummary.failedWorkspaceCount} 个企业主体营销数据暂未纳入汇总`} /> : null}
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
            {canReadMarketingQueue ? <MarketingQueueFiltersSection model={model} onClear={clearQueueFilters} /> : null}
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
