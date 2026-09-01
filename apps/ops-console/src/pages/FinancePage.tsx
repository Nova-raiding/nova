import { CommercialOperationsWorkspace } from "../components/commercial/CommercialOperationsWorkspace.js";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { useCommercialOperations } from "../hooks/useCommercialOperations.js";

interface FinancePageProps {
  model: OpsConsoleModel;
}

export function FinancePage({ model }: FinancePageProps) {
  const commercial = useCommercialOperations(model.authorization);

  return (
    <OpsPage
      eyebrow="COMMERCIAL OPERATIONS"
      title="账务与商业配置"
      headingLevel={1}
      description="处理商业准入阻断、Workspace 权益、创意点账本、版本化目录、支付、费率与服务履约。"
      nextStep="先处理阻断与 unknown；支付成功后仍需核验 grant 与新的 access revision。"
    >
      <CommercialOperationsWorkspace controller={commercial} />
    </OpsPage>
  );
}
