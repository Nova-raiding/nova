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
import { alertChannelNotice, alertDeliveryEvidenceNote, alertDeliveryPresentation } from "./alertNotificationPresentation.js";
import { ALERT_POLL_INTERVAL_MS, formatAlertRefreshedAt, latestRefreshAt, useAlertPolling } from "../../../hooks/alertPolling.js";
import { OpsPageError } from "../../OpsPageError.js";

interface OverviewSectionProps {
  model: OpsConsoleModel;
}

export function isFixturePlatformRow(row: PlatformOperation): boolean {
  return row.dataMode === "fixture" || row.simulated === true || row.state === "fixture_ready";
}

export function platformAuthorizationPresentation(row: PlatformOperation) {
  const accountCount = row.accountCount ?? (row.accountId ? 1 : 0);
  if (isFixturePlatformRow(row)) {
    return {
      color: "gold" as const,
      label: accountCount > 1 ? `${accountCount} 个演示店铺` : "演示授权",
    };
  }
  if (row.state === "connected") {
    return {
      color: "green" as const,
      label: accountCount > 1 ? `${accountCount} 个真实店铺` : "真实授权",
    };
  }
  if (row.state === "partially_connected") {
    const connectedCount = row.connectedAccountCount;
    return connectedCount === undefined
      ? { color: "orange" as const, label: `待确认（共 ${accountCount} 个店铺）` }
      : { color: "orange" as const, label: `${connectedCount}/${accountCount} 个店铺已连接` };
  }
  return { color: "orange" as const, label: "状态待确认" };
}

export function platformReadPresentation(row: PlatformOperation) {
  if (isFixturePlatformRow(row)) {
    return { color: "gold" as const, label: row.readEnabled ? "演示读取" : "演示未启用" };
  }
  return row.readEnabled
    ? { color: "green" as const, label: "已开启" }
    : { color: "default" as const, label: "未开启" };
}

export function platformMediaPresentation(row: PlatformOperation) {
  if (isFixturePlatformRow(row)) {
    return { color: "gold" as const, label: "未验证（fixture）" };
  }
  return row.readiness?.mediaUpload?.ready
    ? { color: "green" as const, label: "可上传" }
    : { color: "orange" as const, label: "媒体阻断" };
}

export function canPublishToProduction(row: PlatformOperation): boolean {
  const capabilities = row.capabilities ?? [];
  const canaryPassed = capabilities.length > 0 && capabilities.every((item) => item.state === "production_canary");
  return !isFixturePlatformRow(row)
    && row.state === "connected"
    && row.readEnabled === true
    && row.writeEnabled === true
    && row.readiness?.ready === true
    && row.readiness.mediaUpload?.ready === true
    && canaryPassed;
}

/**
 * What the unacknowledged-count tag is allowed to claim.
 *
 * `alerts` starts as `[]` and is only replaced by a successful read, so the
 * count is unknown until one lands. Rendering it green while the read is still
 * in flight, or after it failed, states a measured all-clear that was never
 * measured — the operator reads "0 条未确认" over a table that is empty because
 * the request 500'd.
 *
 * `loadedAt` therefore carries a stronger meaning than "some clock ticked": it
 * may only be set by a read that actually landed. Both sources feeding it are
 * held to that — `alertsLoadedAt` is written solely on a committed alert read,
 * and `polling.lastRefreshedAt` only advances when `refreshAlerts` reports a
 * landed read (`createAlertPoller` no longer stamps a poll that declined to
 * issue a request). A poll that reads nothing must leave this tag saying
 * 「未确认数读取中」 rather than reprinting the count as freshly measured.
 */
export function alertCountPresentation(
  count: number,
  { error, loadedAt }: { error?: string; loadedAt?: Date },
): { color: "green" | "red" | "default"; label: string } {
  if (error) return { color: "red", label: "未确认数未知（读取失败）" };
  if (!loadedAt) return { color: "default", label: "未确认数读取中" };
  return { color: count ? "red" : "green", label: `${count} 条未确认` };
}

/**
 * The alert review surface: what happened, whether anyone outside this page
 * was told, and how old the reading is.
 *
 * The delivery column is the only place an operator can see the alert channel
 * working or broken, so it distinguishes all five states instead of collapsing
 * "no attempt was ever recorded" and "the attempt failed" into one neutral tag.
 */
export function OperationalAlertsPanel({ model }: OverviewSectionProps) {
  const {
    alerts,
    alertNotificationReadiness,
    alertsLoadedAt,
    acknowledgeAlert,
    canAuditExport,
    exportOperations,
    refreshAlerts,
    dataSetError,
  } = model;
  const alertsError = dataSetError("ops.alerts.list");
  const channelNotice = alertChannelNotice(alertNotificationReadiness, alerts);
  // A failed read must not switch the poll off: 02:00 incidents arrive while
  // the API is also flaky, and the panel would then never recover on its own.
  const polling = useAlertPolling({
    enabled: Boolean(model.opsSession),
    poll: refreshAlerts,
  });
  // Both inputs are read times, never "the timer fired": nothing here may be
  // fed by an attempt that did not read the dataset.
  const alertsReadAt = latestRefreshAt(alertsLoadedAt, polling.lastRefreshedAt);
  const alertCount = alertCountPresentation(alerts.length, { error: alertsError, loadedAt: alertsReadAt });
  return (
    <Card
      title="待处理平台告警"
      extra={
        <Space>
          <Typography.Text type="secondary" className="ops-alerts-refreshed-at">
            上次刷新：{formatAlertRefreshedAt(alertsReadAt)}
          </Typography.Text>
          <Tag color={alertCount.color}>
            {alertCount.label}
          </Tag>
          {canAuditExport ? <Button size="small" onClick={() => void exportOperations()}>导出运营审计</Button> : null}
          <Button size="small" loading={polling.refreshing} onClick={() => void polling.refresh()}>
            刷新告警
          </Button>
        </Space>
      }
    >
      <OpsPageError error={alertsError ?? ""} onRetry={() => void polling.refresh()} />
      {channelNotice ? (
        <Alert
          className="ops-alert-channel-notice"
          showIcon
          type={channelNotice.tone}
          title={channelNotice.title}
          description={channelNotice.description}
        />
      ) : null}
      <Table
        rowKey="id"
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
        dataSource={alerts}
        locale={{ emptyText: "当前没有未确认告警；空列表不代表没有告警——请确认上方数据集未报错，或点击刷新告警。" }}
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
              const presentation = alertDeliveryPresentation(row);
              return <Tag color={presentation.color} title={presentation.detail}>{presentation.label}</Tag>;
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
      <Typography.Text type="secondary" className="ops-alert-delivery-note">
        {alertDeliveryEvidenceNote(alertNotificationReadiness)} 页面每 {Math.round(ALERT_POLL_INTERVAL_MS / 1000)} 秒自动刷新一次，切回本标签页时立即刷新。
      </Typography.Text>
    </Card>
  );
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
      <OperationalAlertsPanel model={model} />

      <Card
        title="平台上线 readiness"
        extra={<Tag color="gold">真实 canary 前保持只读</Tag>}
      >
        <Table
          rowKey={(row: PlatformOperation) =>
            row.platform
          }
          pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
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
              render: (_: string | undefined, row: PlatformOperation) => {
                const presentation = platformAuthorizationPresentation(row);
                return <Tag color={presentation.color}>{presentation.label}</Tag>;
              },
            },
            {
              title: "读取",
              dataIndex: "readEnabled",
              render: (_: boolean | undefined, row: PlatformOperation) => {
                const presentation = platformReadPresentation(row);
                return <Tag color={presentation.color}>{presentation.label}</Tag>;
              },
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
                const presentation = platformMediaPresentation(row);
                return <Tag color={presentation.color}>{presentation.label}</Tag>;
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
