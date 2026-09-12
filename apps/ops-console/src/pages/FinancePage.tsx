import { CommercialOperationsWorkspace } from "../components/commercial/CommercialOperationsWorkspace.js";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { commercialViewCapability, useCommercialOperations } from "../hooks/useCommercialOperations.js";
import { CommercialReadinessPanel } from "../components/commercial/CommercialReadinessPanel.js";
import { FinanceSearchSection } from "../components/finance/FinanceSearchSection.js";
import { ReconciliationSection } from "../components/finance/ReconciliationSection.js";
import { RechargeOrdersSection } from "../components/finance/RechargeOrdersSection.js";
import { RefundSection } from "../components/finance/RefundSection.js";
import { financeSearchClient } from "../api/opsDomainClients.js";
import { useFinanceSearch } from "../hooks/useFinanceSearch.js";
import { DollarOutlined, ReloadOutlined, SafetyCertificateOutlined, TransactionOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Input, Row, Space, Statistic, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
interface FinancePageProps { model: OpsConsoleModel; }

function PlatformFinanceOverview({ summary }: { summary: OpsConsoleModel["platformFinanceSummary"] }) {
  return (
    <section className="ops-finance-platform-overview" aria-labelledby="ops-finance-platform-overview-title">
      <div className="ops-finance-section-heading">
        <div>
          <Typography.Text className="ops-finance-section-kicker">PLATFORM FINANCE</Typography.Text>
          <Typography.Title level={3} id="ops-finance-platform-overview-title">平台账务概览</Typography.Title>
          <Typography.Text type="secondary">按平台全局范围查看商家订单、钱包流水和模型成本证据。</Typography.Text>
        </div>
        <Tag color={summary ? "success" : "default"}>{summary ? "汇总已读取" : "等待数据"}</Tag>
      </div>
      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-finance-platform-metric">
            <Statistic title="财务记录" value={summary?.totalRecords ?? "—"} prefix={<TransactionOutlined />} />
            <Typography.Text type="secondary">当前平台检索范围内的记录数</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-finance-platform-metric">
            <Statistic title="真实充值到账" value={summary?.verifiedRechargeOrderCny ?? "—"} precision={summary?.verifiedRechargeOrderCny === undefined ? undefined : 2} prefix={<DollarOutlined />} suffix={summary?.verifiedRechargeOrderCny === undefined ? undefined : " 元"} />
            <Typography.Text type="secondary">已支付且非本地 fixture 的充值金额</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-finance-platform-metric">
            <Statistic title="客户计费" value={summary?.customerChargeCny ?? "—"} precision={summary ? 6 : undefined} prefix={<DollarOutlined />} suffix={summary ? " 元" : undefined} />
            <Typography.Text type="secondary">模型用量对应的客户计费快照</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-finance-platform-metric">
            <Statistic title="成本证据" value={summary?.providerCostStatus === "verified" ? "已核验" : summary ? "需关注" : "—"} prefix={<SafetyCertificateOutlined />} />
            <Typography.Text type="secondary">{summary?.missingCostEvidenceCount ? `${summary.missingCostEvidenceCount} 条记录缺少成本证据` : "平台成本证据状态"}</Typography.Text>
          </Card>
        </Col>
      </Row>
    </section>
  );
}
export function FinancePage({ model }: FinancePageProps) {
  const isPlatformWorkbench = model.opsSession?.workbench
    ? model.opsSession.workbench === "platform"
    : model.authorization.scope.kind === "platform";
  const commercial = useCommercialOperations(model.authorization, undefined, !isPlatformWorkbench);
  const [workspaceDraft, setWorkspaceDraft] = useState(commercial.targetWorkspaceId);
  useEffect(() => setWorkspaceDraft(commercial.targetWorkspaceId), [commercial.targetWorkspaceId]);
  const canRefresh = model.authorization.can("commercial.access.read") && model.authorization.can(commercialViewCapability[commercial.view]);
  const canSearchFinance = model.authorization.can("billing.platform.read");
  const isWorkspaceWorkbench = !isPlatformWorkbench;
  const financeSearch = useFinanceSearch(financeSearchClient, { limit: 20 }, canSearchFinance);
  useEffect(() => {
    // Platform sessions must not hydrate workspace-scoped recharge orders.
    // The API correctly rejects that request, but issuing it from the page
    // creates a misleading 403 in the platform walk and can mask real errors.
    if (isWorkspaceWorkbench && !canSearchFinance) void model.loadRechargeOrders();
  }, [canSearchFinance, isWorkspaceWorkbench]);
  return (
    <OpsPage
      eyebrow="COMMERCIAL OPERATIONS"
      title={isPlatformWorkbench ? "平台财务中心" : "账务与商业配置"}
      headingLevel={2}
      description={isPlatformWorkbench ? "查看全平台财务记录、企业主体商业化开通状态和成本证据，平台范围由服务端权限投影决定。" : "处理企业主体商业准入、权益、创意点账本、版本化目录、支付、费率与服务履约。"}
      actions={isPlatformWorkbench ? (
        <Space wrap>
          <Tag color="blue">平台工作台</Tag>
          <Button type="primary" icon={<ReloadOutlined />} loading={financeSearch.loading} disabled={!canSearchFinance} onClick={() => void Promise.all([financeSearch.search(), model.load()])}>刷新平台账务</Button>
        </Space>
      ) : (
        <Space wrap>
          <Typography.Text type="secondary">目标企业主体</Typography.Text>
          <Input aria-label="商业目标企业主体 Workspace ID" placeholder="例如 ws_demo" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} onPressEnter={() => commercial.setTargetWorkspace(workspaceDraft)} style={{ width: 180 }} />
          <Button onClick={() => commercial.setTargetWorkspace(workspaceDraft)} disabled={!workspaceDraft.trim()}>应用范围</Button>
          <Button type="primary" disabled={!canRefresh} loading={commercial.summary.status === "loading" || commercial.data[commercial.view].status === "loading"} onClick={() => void Promise.all([commercial.loadSummary(), commercial.loadView()])}>刷新账务</Button>
        </Space>
      )}
      nextStep={isPlatformWorkbench ? "先核对跨企业主体财务记录和成本证据，再进入对应企业主体处理具体订单或权益。" : "先处理阻断与待对账事项；支付成功后仍需核验权益发放与新的访问版本。"}
    >
      <div className="ops-finance-page">
        {isPlatformWorkbench ? <Typography.Title level={3} style={{ margin: 0 }}>账务与商业配置</Typography.Title> : null}
        {isPlatformWorkbench ? <>
          <PlatformFinanceOverview summary={model.platformFinanceSummary} />
          {canSearchFinance ? <FinanceSearchSection controller={financeSearch} showProviderStatementStatus={false} /> : (
            <Alert
              type="info"
              showIcon
              title="平台财务检索未授权"
              description="当前会话未获得服务端投影的 billing.platform.read 能力，因此没有发起跨企业主体财务查询。请由平台管理员更新权限后重新登录。"
            />
          )}
          <CommercialReadinessPanel authorization={model.authorization} />
        </> : <>
          <ReconciliationSection model={model} />
          <RechargeOrdersSection model={model} />
          <RefundSection model={model} />
          <CommercialOperationsWorkspace controller={commercial} />
        </>}
      </div>
    </OpsPage>
  );
}
