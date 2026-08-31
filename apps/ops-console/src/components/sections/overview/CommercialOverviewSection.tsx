import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  CloudSyncOutlined,
  DollarOutlined,
  DownloadOutlined,
  GlobalOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type {
  DataDeletionRequest,
  OperationalAlert,
  WorkspaceSummary,
} from "../../../types/ops";

interface OverviewSectionProps {
  model: OpsConsoleModel;
}

export function CommercialOverviewSection({ model }: OverviewSectionProps) {
  const {
    settings,
    setSettings,
    platformRows,
    setPlatformRows,
    audits,
    setAudits,
    subscription,
    setSubscription,
    orders,
    setOrders,
    members,
    setMembers,
    workspaceRows,
    setWorkspaceRows,
    reconciliation,
    setReconciliation,
    offers,
    setOffers,
    addons,
    setAddons,
    coupons,
    setCoupons,
    rollouts,
    setRollouts,
    modelMarkup,
    setModelMarkup,
    modelMarkupReason,
    setModelMarkupReason,
    funnel,
    setFunnel,
    platformHealth,
    setPlatformHealth,
    platformOperations,
    setPlatformOperations,
    storeDirectory,
    setStoreDirectory,
    dataLifecycle,
    setDataLifecycle,
    productionEvidence,
    setProductionEvidence,
    alerts,
    setAlerts,
    deletionRequests,
    setDeletionRequests,
    modelStatus,
    setModelStatus,
    rules,
    setRules,
    knowledgeRules,
    setKnowledgeRules,
    knowledgeAssets,
    setKnowledgeAssets,
    learningSuggestions,
    setLearningSuggestions,
    competitors,
    setCompetitors,
    workspaceMetrics,
    setWorkspaceMetrics,
    marketingQueue,
    setMarketingQueue,
    queueFilters,
    setQueueFilters,
    alertFilters,
    setAlertFilters,
    automationPolicy,
    setAutomationPolicy,
    automationPolicies,
    setAutomationPolicies,
    automationScan,
    setAutomationScan,
    automationScope,
    setAutomationScope,
    selectedStoreScope,
    setSelectedStoreScope,
    opsSession,
    setOpsSession,
    loading,
    setLoading,
    saving,
    setSaving,
    error,
    setError,
    memberForm,
    refundForm,
    ruleForm,
    knowledgeRuleForm,
    knowledgeAssetForm,
    competitorForm,
    load,
    loadRules,
    enabledCount,
    can,
    canFinance,
    canPlatformOps,
    canModelMarkup,
    canKnowledge,
    canCompetitor,
    canRules,
    canQueue,
    canMembers,
    selectedAutomationStore,
    automationScopeParams,
    updateRuleStatus,
    publishRuleDraft,
    saveCommercial,
    savePlatform,
    saveStoreAlias,
    revokeStore,
    saveMember,
    refund,
    runReconciliation,
    exportBilling,
    exportOperations,
    acknowledgeAlert,
    confirmLearning,
    createKnowledgeRule,
    createKnowledgeAsset,
    updateKnowledgeAsset,
    dismissLearning,
    governUploadedAsset,
    createCompetitor,
    cancelDeletion,
    approveDeletion,
    saveOffer,
    saveAddon,
    saveCoupon,
    saveRollout,
    loadModelMarkup,
    saveModelMarkup,
    loadAutomationScope,
    updateAutomation,
    updateAutomationSync,
    scanAutomation,
    assignQueueItem,
    retryGeneration,
    acknowledgePublish,
    createRevision,
    reviewVisual,
  } = model;
  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="当前套餐"
              value={settings?.planName ?? "-"}
              prefix={<SafetyCertificateOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="订阅状态"
              value={subscription?.status ?? "-"}
              prefix={<CloudSyncOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="平台已启用"
              value={`${enabledCount} / ${platformRows.length || 6}`}
              prefix={<GlobalOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="钱包余额"
              value={reconciliation ? `¥${reconciliation.balance_cny}` : "-"}
              prefix={<DollarOutlined />}
            />
          </Card>
        </Col>
      </Row>
      <Card title="工作区与财务总览">
        <Table
          rowKey="workspaceId"
          pagination={{ pageSize: 6 }}
          dataSource={workspaceRows}
          columns={[
            { title: "工作区", dataIndex: "workspaceId" },
            { title: "状态", dataIndex: "status" },
            { title: "套餐", dataIndex: "planName" },
            { title: "订阅", dataIndex: "subscriptionStatus" },
            {
              title: "任务用量",
              render: (_: unknown, row: WorkspaceSummary) =>
                String(row.usedTasks) + " / " + String(row.includedTasks),
            },
            { title: "成员数", dataIndex: "memberCount" },
          ]}
        />
      </Card>
      <Card title="渠道转化漏斗" extra={<Tag color="cyan">仅统计业务事件</Tag>}>
        <Row gutter={[16, 16]}>
          {Object.entries(funnel.counts).map(([event, count]) => (
            <Col xs={12} md={6} key={event}>
              <Statistic title={event} value={count} />
            </Col>
          ))}
          <Col xs={12} md={6}>
            <Statistic title="事件总数" value={funnel.totalEvents} />
          </Col>
        </Row>
      </Card>
    </>
  );
}
