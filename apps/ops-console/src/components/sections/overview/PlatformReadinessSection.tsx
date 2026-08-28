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
import type { OperationalAlert, PlatformOperation } from "../../../types/ops";

interface OverviewSectionProps {
  model: OpsConsoleModel;
}

export function PlatformReadinessSection({ model }: OverviewSectionProps) {
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
    sessionRoles,
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
      <Card
        title="待处理平台告警"
        extra={
          <Space>
            <Tag color={alerts.length ? "red" : "green"}>
              {alerts.length} 条未确认
            </Tag>
            <Button size="small" onClick={() => void exportOperations()}>
              导出运营审计
            </Button>
            <Button size="small" onClick={() => void load()}>
              刷新告警
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          pagination={{ pageSize: 6 }}
          dataSource={alerts}
          columns={[
            {
              title: "级别",
              dataIndex: "severity",
              render: (value: string) => (
                <Tag color={value === "high" ? "red" : "orange"}>
                  {value === "high" ? "高" : "中"}
                </Tag>
              ),
            },
            {
              title: "平台",
              dataIndex: "platform",
              render: (value: string | undefined) =>
                value?.toUpperCase() || "全局",
            },
            { title: "告警", dataIndex: "title" },
            {
              title: "对象",
              render: (_: unknown, row: OperationalAlert) =>
                `${row.entityType} / ${row.entityId}`,
            },
            { title: "下一步", dataIndex: "nextAction" },
            {
              title: "操作",
              render: (_: unknown, row: OperationalAlert) => (
                <Button type="link" onClick={() => void acknowledgeAlert(row)}>
                  确认
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="平台上线 readiness"
        extra={<Tag color="gold">真实 canary 前保持只读</Tag>}
      >
        <Table
          rowKey={(row: PlatformOperation) =>
            `${row.platform}:${row.accountId ?? "unbound"}`
          }
          pagination={false}
          dataSource={
            platformOperations.length
              ? platformOperations
              : Object.entries(platformHealth).map(([platform, value]) => ({
                  platform,
                  readiness: value,
                }))
          }
          columns={[
            {
              title: "平台",
              dataIndex: "platform",
              render: (value: string) => <Tag>{value.toUpperCase()}</Tag>,
            },
            {
              title: "店铺授权",
              dataIndex: "state",
              render: (value: string | undefined) => (
                <Tag
                  color={
                    value === "connected" || value === "fixture_ready"
                      ? "green"
                      : "orange"
                  }
                >
                  {value || "unknown"}
                </Tag>
              ),
            },
            {
              title: "读取",
              dataIndex: "readEnabled",
              render: (value: boolean | undefined) => (
                <Tag color={value ? "green" : "default"}>
                  {value ? "enabled" : "off"}
                </Tag>
              ),
            },
            {
              title: "写入",
              dataIndex: "writeEnabled",
              render: (value: boolean | undefined) => (
                <Tag color={value ? "green" : "red"}>
                  {value ? "enabled" : "blocked"}
                </Tag>
              ),
            },
            {
              title: "能力证据",
              render: (_: unknown, row: PlatformOperation) => {
                const capabilities = row.capabilities ?? [];
                const canary = capabilities.filter(
                  (item) => item.state === "production_canary",
                ).length;
                return (
                  <Typography.Text>
                    {canary}/{capabilities.length || 8} production_canary
                  </Typography.Text>
                );
              },
            },
            {
              title: "连接器",
              render: (_: unknown, row: PlatformOperation) => (
                <Tag color={row.readiness?.ready ? "green" : "red"}>
                  {row.readiness?.ready ? "ready" : "blocked"}
                </Tag>
              ),
            },
            {
              title: "主/副图媒体",
              render: (_: unknown, row: PlatformOperation) => {
                const media = row.readiness?.mediaUpload;
                return (
                  <Tag color={media?.ready ? "green" : "orange"}>
                    {media?.ready ? "可上传" : "媒体门禁"}
                  </Tag>
                );
              },
            },
            {
              title: "阻断原因",
              render: (_: unknown, row: PlatformOperation) =>
                [
                  ...(row.readiness?.reasons ?? []),
                  ...(row.readiness?.mediaUpload?.reason
                    ? [`媒体：${row.readiness.mediaUpload.reason}`]
                    : []),
                ].join("、") || "无",
            },
          ]}
        />
      </Card>
    </>
  );
}
