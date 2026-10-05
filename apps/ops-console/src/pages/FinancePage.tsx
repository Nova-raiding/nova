import { AssistedPurchaseOperationsPanel, CashReceiptOperationsPanel, CommercialOperationsWorkspace, CommercialRefundOperationsPanel } from "../components/commercial/CommercialOperationsWorkspace.js";
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
import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Select, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { PlatformCatalogManagementPanel } from "../components/commercial/PlatformCatalogManagementPanel.js";

export { catalogPriceYuan } from "../components/commercial/catalogManagementModel.js";

interface FinancePageProps { model: OpsConsoleModel; }
export function FinancePage({ model }: FinancePageProps) {
  const isPlatformWorkbench = model.opsSession?.workbench
    ? model.opsSession.workbench === "platform"
    : model.authorization.scope.kind === "platform";
  const canReconcileCommercialRefund = isPlatformWorkbench && model.authorization.can("commercial.payment.reconcile");
  const canOperateCrossWorkspaceCommercial = isPlatformWorkbench &&
    model.authorization.can("commercial.order.read") && model.authorization.can("commercial.catalog.read");
  const commercial = useCommercialOperations(model.authorization, undefined, !isPlatformWorkbench || canOperateCrossWorkspaceCommercial, canReconcileCommercialRefund);
  const workspaceDraft = commercial.targetWorkspaceId;
  const workspaceOptions = model.workspaceRows.map(row => ({ value: row.workspaceId, label: `${row.enterpriseName || row.workspaceId} · ${row.workspaceId}` }));
  if (workspaceDraft && !workspaceOptions.some(option => option.value === workspaceDraft)) {
    workspaceOptions.unshift({ value: workspaceDraft, label: `当前目标 · ${workspaceDraft}` });
  }
  const selectedWorkspace = model.workspaceRows.find(row => row.workspaceId === workspaceDraft);
  const canRefresh = model.authorization.can("commercial.access.read") && model.authorization.can(commercialViewCapability[commercial.view]);
  const canSearchFinance = model.authorization.can("billing.platform.read");
  const isWorkspaceWorkbench = !isPlatformWorkbench;
  const financeSearch = useFinanceSearch(financeSearchClient, { limit: 20 }, canSearchFinance);
  const [showCommercialReadiness, setShowCommercialReadiness] = useState(false);
  useEffect(() => {
    // Platform sessions must not hydrate workspace-scoped recharge orders.
    // The API correctly rejects that request, but issuing it from the page
    // creates a misleading 403 in the platform walk and can mask real errors.
    if (isWorkspaceWorkbench && !canSearchFinance) void model.loadRechargeOrders();
  }, [canSearchFinance, isWorkspaceWorkbench]);
  return (
    <OpsPage
      title={isPlatformWorkbench ? "平台财务中心" : "账务与商业配置"}
      headingLevel={2}
      description={isPlatformWorkbench ? undefined : "处理企业主体商业准入、权益、创意点账本、版本化目录、支付、费率与服务履约。"}
      actions={isPlatformWorkbench ? (
        <Space wrap>
          <Button type="primary" icon={<ReloadOutlined />} loading={financeSearch.loading} disabled={!canSearchFinance} onClick={() => void Promise.all([financeSearch.search(), model.load()])}>刷新平台账务</Button>
          {canReconcileCommercialRefund ? <>
            <Select aria-label="代购与收款目标企业主体" showSearch optionFilterProp="label" placeholder="选择目标企业主体" value={workspaceDraft || undefined} options={workspaceOptions} onChange={commercial.setTargetWorkspace} style={{ width: 300 }} />
          </> : null}
        </Space>
      ) : (
        <Space wrap>
          <Typography.Text type="secondary">目标企业主体</Typography.Text>
          <Select aria-label="商业目标企业主体" showSearch optionFilterProp="label" placeholder="从授权企业中选择" value={workspaceDraft || undefined} options={workspaceOptions} onChange={commercial.setTargetWorkspace} style={{ width: 300 }} />
          <Button type="primary" disabled={!canRefresh} loading={commercial.summary.status === "loading" || commercial.data[commercial.view].status === "loading"} onClick={() => void Promise.all([commercial.loadSummary(), commercial.loadView()])}>刷新账务</Button>
        </Space>
      )}
      nextStep={isPlatformWorkbench ? undefined : "先处理阻断与待对账事项；支付成功后仍需核验权益发放与新的访问版本。"}
    >
      <div className="ops-finance-page">
        {workspaceDraft ? <Alert type="info" showIcon title={`当前企业：${selectedWorkspace?.enterpriseName || workspaceDraft}`} description={`财务和商业操作范围：${workspaceDraft}`} style={{ marginBottom: 16 }} /> : null}
        {isPlatformWorkbench ? <>
          {canSearchFinance ? <FinanceSearchSection controller={financeSearch} showProviderStatementStatus={false} compactSummary /> : (
            <Alert
              type="info"
              showIcon
              title="平台财务检索未授权"
              description="当前会话未获得服务端投影的 billing.platform.read 能力，因此没有发起跨企业主体财务查询。请由平台管理员更新权限后重新登录。"
            />
          )}
          {model.authorization.can("commercial.payment.reconcile") && model.authorization.can("commercial.order.read") ? <AssistedPurchaseOperationsPanel controller={commercial} /> : null}
          {model.authorization.can("commercial.receipt.record") || model.authorization.can("commercial.receipt.allocate") ? <CashReceiptOperationsPanel controller={commercial} /> : null}
          {model.authorization.can("commercial.catalog.read") ? <PlatformCatalogManagementPanel model={model} /> : null}
          <Card
            size="small"
            className="ops-finance-secondary-panel"
            title="商业化生产门禁"
            extra={<Button type="link" onClick={() => setShowCommercialReadiness((visible) => !visible)}>{showCommercialReadiness ? "收起证据" : "查看证据"}</Button>}
          >
            <Typography.Text type="secondary">仅在核对 SKU、商业规则和费率证据时展开；它不会影响平台账务检索。</Typography.Text>
            {showCommercialReadiness ? <div style={{ marginTop: 12 }}><CommercialReadinessPanel authorization={model.authorization} /></div> : null}
          </Card>
          {canReconcileCommercialRefund ? <CommercialRefundOperationsPanel controller={commercial} /> : null}
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
