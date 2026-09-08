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
import { CommercialReadinessPanel } from "../../commercial/CommercialReadinessPanel";

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
  const realPlatformCount = new Set(
    platformOperations
      .filter((row) => row.dataMode === "official_api" && row.readEnabled === true)
      .map((row) => row.platform),
  ).size;
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
              title="真实平台接入"
              value={`${realPlatformCount} / 6`}
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
      <CommercialReadinessPanel authorization={model.authorization} />
      <Card title="ChatGPT 插件接入" style={{ marginTop: 16 }}>
        <Space orientation="vertical" size="small">
          <Typography.Text>插件绑定跟随当前工作区和认证身份完成，不需要把 Token 粘贴到对话中。</Typography.Text>
          <Typography.Text>
            当前工作区：<Typography.Text code copyable={model.opsSession?.workspace_id ? { text: model.opsSession.workspace_id } : false}>{model.opsSession?.workspace_id ?? "尚未通过登录验证"}</Typography.Text>
          </Typography.Text>
          <Typography.Text type="secondary">使用方式：在 ChatGPT 中启用“大麦商家营销”，发送“开始使用大麦”；插件会调用 workspace.bootstrap（首次）或 workspace.health（恢复）并返回绑定状态。</Typography.Text>
        </Space>
      </Card>
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
