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
import { Button, Input, Space, Typography } from "antd";
import { useEffect, useState } from "react";

interface FinancePageProps {
  model: OpsConsoleModel;
}

export function FinancePage({ model }: FinancePageProps) {
  const commercial = useCommercialOperations(model.authorization);
  const [workspaceDraft, setWorkspaceDraft] = useState(commercial.targetWorkspaceId);
  useEffect(() => setWorkspaceDraft(commercial.targetWorkspaceId), [commercial.targetWorkspaceId]);
  const canRefresh = model.authorization.can("commercial.access.read") && model.authorization.can(commercialViewCapability[commercial.view]);
  const canSearchFinance = model.authorization.can("ops.finance.search");
  const isWorkspaceWorkbench = model.opsSession?.workbench === "workspace";
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
      title="账务与商业配置"
      headingLevel={2}
      description="处理商业准入阻断、Workspace 权益、创意点账本、版本化目录、支付、费率与服务履约。"
      actions={<Space wrap>
        <Typography.Text type="secondary">目标 Workspace</Typography.Text>
        <Input aria-label="商业目标 Workspace" placeholder="例如 ws_demo" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} onPressEnter={() => commercial.setTargetWorkspace(workspaceDraft)} style={{ width: 180 }} />
        <Button onClick={() => commercial.setTargetWorkspace(workspaceDraft)} disabled={!workspaceDraft.trim()}>应用范围</Button>
        <Button type="primary" disabled={!canRefresh} loading={commercial.summary.status === "loading" || commercial.data[commercial.view].status === "loading"} onClick={() => void Promise.all([commercial.loadSummary(), commercial.loadView()])}>刷新账务</Button>
      </Space>}
      nextStep="先处理阻断与 unknown；支付成功后仍需核验 grant 与新的 access revision。"
    >
      <div className="ops-finance-page">
        <CommercialReadinessPanel authorization={model.authorization} />
        {canSearchFinance ? <FinanceSearchSection controller={financeSearch} /> : <>
          <ReconciliationSection model={model} />
          <RechargeOrdersSection model={model} />
          <RefundSection model={model} />
        </>}
        <CommercialOperationsWorkspace controller={commercial} />
      </div>
    </OpsPage>
  );
}
