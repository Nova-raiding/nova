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

export function canPublishToProduction(row: PlatformOperation): boolean {
  const capabilities = row.capabilities ?? [];
  const canaryPassed = capabilities.length > 0 && capabilities.every((item) => item.state === "production_canary");
  return row.state === "connected"
    && row.readEnabled === true
    && row.writeEnabled === true
    && row.readiness?.ready === true
    && row.readiness.mediaUpload?.ready === true
    && canaryPassed;
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
    can,
    canFinance,
    canPlatformOps,
    canModelMarkup,
    canKnowledge,
    canCompetitor,
    canRules,
    canQueue,
    canMembers,
    canAuditExport,
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
            {canAuditExport ? <Button size="small" onClick={() => void exportOperations()}>导出运营审计</Button> : null}
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
              title: "通知",
              render: (_: unknown, row: OperationalAlert) => {
                const delivery = row.notification?.delivery;
                const color = delivery === "delivered" ? "green" : delivery === "failed" ? "red" : delivery === "blocked" ? "orange" : "default";
                const label = delivery === "delivered" ? "已投递" : delivery === "failed" ? "失败" : delivery === "blocked" ? "被阻断" : delivery === "disabled" ? "未启用" : "待记录";
                return <Tag color={color}>{label}{row.notification ? ` · ${row.notification.attempts}次` : ""}</Tag>;
              },
            },
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
              render: (value: string | undefined) => {
                const simulated = value === "fixture_ready";
                const connected = value === "connected";
                return (
                  <Tag color={simulated ? "gold" : connected ? "green" : "orange"}>
                    {simulated ? "演示授权" : connected ? "真实授权" : value || "未知"}
                  </Tag>
                );
              },
            },
            {
              title: "读取",
              dataIndex: "readEnabled",
              render: (value: boolean | undefined) => (
                <Tag color={value ? "green" : "default"}>
                  {value ? "已开启" : "未开启"}
                </Tag>
              ),
            },
            {
              title: "写入",
              dataIndex: "writeEnabled",
              render: (value: boolean | undefined) => (
                <Tag color={value ? "green" : "red"}>
                  {value ? "已开启" : "已阻断"}
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
                    {canary}/{capabilities.length || 8} 生产 canary
                  </Typography.Text>
                );
              },
            },
            {
              title: "生产发布",
              render: (_: unknown, row: PlatformOperation) => (
                <Tag color={canPublishToProduction(row) ? "green" : "red"}>
                  {canPublishToProduction(row) ? "允许生产发布" : "生产发布阻断"}
                </Tag>
              ),
            },
            {
              title: "主/副图媒体",
              render: (_: unknown, row: PlatformOperation) => {
                const media = row.readiness?.mediaUpload;
                return (
                  <Tag color={media?.ready ? "green" : "orange"}>
                    {media?.ready ? "可上传" : "媒体阻断"}
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
