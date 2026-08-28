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
  EvidenceReadiness,
  OperationalAlert,
  WorkspaceSummary,
} from "../../../types/ops";

interface OverviewSectionProps {
  model: OpsConsoleModel;
}

export function DataReadinessSection({ model }: OverviewSectionProps) {
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
        title="数据生命周期 readiness"
        extra={
          <Tag
            color={
              dataLifecycle.state === "ready" ||
              dataLifecycle.state === "not_required"
                ? "green"
                : "red"
            }
          >
            {dataLifecycle.state === "not_required"
              ? "非生产模式"
              : dataLifecycle.state === "ready"
                ? "已配置"
                : "阻断"}
          </Tag>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={12} md={4}>
            <Statistic
              title="业务保留"
              value={dataLifecycle.retentionDays ?? "-"}
              suffix="天"
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="隔离区"
              value={dataLifecycle.quarantineRetentionDays ?? "-"}
              suffix="天"
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="Clean"
              value={dataLifecycle.cleanRetentionDays ?? "-"}
              suffix="天"
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="删除宽限"
              value={dataLifecycle.deletionGraceDays ?? "-"}
              suffix="天"
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="备份保留"
              value={dataLifecycle.backupRetentionDays ?? "-"}
              suffix="天"
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="对象版本化"
              value={dataLifecycle.objectVersioning ? "开启" : "未开启"}
            />
          </Col>
        </Row>
        {dataLifecycle.reasons?.length ? (
          <Alert
            type="error"
            showIcon
            title="上线阻断原因"
            description={dataLifecycle.reasons.join("；")}
          />
        ) : (
          <Typography.Text type="secondary">
            生命周期数值和策略引用不包含 Secret，仅用于上线门禁和运营核对。
          </Typography.Text>
        )}
      </Card>
      <Card
        title="生产证据 readiness"
        extra={
          <Tag
            color={
              productionEvidence.capability.state === "ready" &&
              productionEvidence.capacity.state === "ready"
                ? "green"
                : "red"
            }
          >
            {productionEvidence.capability.state === "ready" &&
            productionEvidence.capacity.state === "ready"
              ? "证据完整"
              : "未通过门禁"}
          </Tag>
        }
      >
        <Table
          rowKey="kind"
          pagination={false}
          dataSource={[
            {
              kind: "六平台 capability",
              ...productionEvidence.capability,
            },
            { kind: "容量压测", ...productionEvidence.capacity },
          ]}
          columns={[
            { title: "证据类型", dataIndex: "kind" },
            {
              title: "状态",
              dataIndex: "state",
              render: (value: string) => (
                <Tag
                  color={
                    value === "ready"
                      ? "green"
                      : value === "not_required"
                        ? "gold"
                        : "red"
                  }
                >
                  {value}
                </Tag>
              ),
            },
            {
              title: "环境",
              dataIndex: "environment",
              render: (value: string | undefined) => value || "-",
            },
            {
              title: "Release",
              dataIndex: "releaseId",
              render: (value: string | undefined) => value || "-",
            },
            {
              title: "版本/Profile",
              render: (_: unknown, row: EvidenceReadiness) =>
                row.profile || row.schemaVersion || "-",
            },
            {
              title: "核验人/时间",
              render: (_: unknown, row: EvidenceReadiness) =>
                row.verifiedBy
                  ? `${row.verifiedBy} / ${row.verifiedAt ?? "-"}`
                  : "-",
            },
            {
              title: "阻断原因",
              dataIndex: "reasons",
              render: (value: string[] | undefined) =>
                (value ?? []).join("；") || "无",
            },
          ]}
        />
        <Typography.Text type="secondary">
          仅显示脱敏元数据；示例、fixture、test_e2e
          或本地容量结果不会被计为生产通过。
        </Typography.Text>
      </Card>
      <Card
        title="数据删除申请"
        extra={<Tag color="orange">双人审批后仍需外部删除证明</Tag>}
      >
        <Table
          rowKey="id"
          pagination={{ pageSize: 6 }}
          dataSource={deletionRequests}
          columns={[
            {
              title: "范围",
              dataIndex: "scope",
              render: (value: string) => <Tag>{value}</Tag>,
            },
            { title: "原因", dataIndex: "reason" },
            { title: "申请人", dataIndex: "requestedBy" },
            {
              title: "审批数",
              render: (_: unknown, row: DataDeletionRequest) =>
                `${row.approvals?.length ?? 0} / 2`,
            },
            {
              title: "计划执行",
              dataIndex: "scheduledFor",
              render: (value: string) => new Date(value).toLocaleString(),
            },
            { title: "状态", dataIndex: "status" },
            {
              title: "操作",
              render: (_: unknown, row: DataDeletionRequest) =>
                row.status === "pending" ? (
                  <Space>
                    <Button
                      type="link"
                      onClick={() => void approveDeletion(row)}
                    >
                      审批
                    </Button>
                    <Button
                      type="link"
                      danger
                      onClick={() => void cancelDeletion(row)}
                    >
                      取消申请
                    </Button>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    外部执行/证明
                  </Typography.Text>
                ),
            },
          ]}
        />
      </Card>
    </>
  );
}
