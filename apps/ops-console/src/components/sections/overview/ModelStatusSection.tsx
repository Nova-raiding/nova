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

export function ModelStatusSection({ model }: OverviewSectionProps) {
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
        title="平台模型服务"
        extra={
          <Tag color={!modelStatus ? "default" : modelStatus.state === "ready" ? "green" : "red"}>
            {modelStatus?.state ?? "加载中"}
          </Tag>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={6}>
            <Statistic title="模型归属" value="平台统一" />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="自有中转站"
              value={modelStatus?.relay?.configured ? "已配置" : "未配置"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="文案模型"
              value={modelStatus?.text_model ?? "-"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="图片模型"
              value={modelStatus?.image_model ?? "-"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="OCR 模型"
              value={modelStatus?.vision_model ?? "-"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title="视频模型"
              value={modelStatus?.video_model ?? "-"}
            />
          </Col>
        </Row>
        <Typography.Paragraph type="secondary">
          用户不能填写或绑定模型
          Key；平台负责模型费用，商家通过充值和套餐额度使用插件能力。中转站{" "}
          {modelStatus?.relay?.host ?? "-"}。模型状态：文案{" "}
          {modelStatus?.model_readiness?.text?.provider_configured
            ? "可用"
            : "阻断"}
          、图片{" "}
          {modelStatus?.model_readiness?.image?.provider_configured
            ? "可用"
            : "阻断"}
          、局部编辑{" "}
          {modelStatus?.model_readiness?.image_edit?.provider_configured
            ? "可用"
            : "阻断"}
          、OCR{" "}
          {modelStatus?.model_readiness?.ocr?.provider_configured
            ? "可用"
            : "人工兜底"}
          、视频{" "}
          {modelStatus?.model_readiness?.video?.provider_configured
            ? "可渲染"
            : "仅分镜"}
          。RPM {modelStatus?.quotas.rpm ?? "-"}，TPM{" "}
          {modelStatus?.quotas.tpm ?? "-"}，日成本上限{" "}
          {modelStatus?.quotas.daily_cny_limit ?? "-"} 元。发布元数据{" "}
          {modelStatus?.release_metadata_ready ? "已就绪" : "未就绪"}。
        </Typography.Paragraph>
        {!modelStatus ? (
          <Alert
            type="info"
            showIcon
            title={model.modelStatusLoading ? "正在加载平台模型状态" : "平台模型状态不可用"}
            description={model.modelStatusLoading ? "请稍候，正在读取中转站与成本门禁。" : "请检查页面顶部错误并重试，当前状态不能视为配置完成。"}
          />
        ) : modelStatus.next_actions.length ? (
          <Alert
            type="warning"
            showIcon
            title="模型上线门禁"
            description={modelStatus.next_actions.join("；")}
          />
        ) : (
          <Alert type="success" showIcon title="平台模型配置完整" />
        )}
      </Card>
    </>
  );
}
