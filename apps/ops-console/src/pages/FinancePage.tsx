import { ConfigurationCenterSection } from "../components/finance/ConfigurationCenterSection";
import { PlanBillingSection } from "../components/finance/PlanBillingSection";
import { ReconciliationSection } from "../components/finance/ReconciliationSection";
import { RefundSection } from "../components/finance/RefundSection";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface FinancePageProps {
  model: OpsConsoleModel;
}

export function FinancePage({ model }: FinancePageProps) {
  const { error, load } = model;

  return (
    <OpsPage
      eyebrow="BILLING OPERATIONS"
      title="账务与商业配置"
      description="管理充值、账单、退款、套餐和模型计费策略。"
    >
      <OpsPageError error={error} onRetry={() => void load()} />
      <ReconciliationSection model={model} />
      <RefundSection model={model} />
      <ConfigurationCenterSection model={model} />
      <PlanBillingSection model={model} />
    </OpsPage>
  );
}
