import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AutomationPolicySection } from "../components/stores/AutomationPolicySection";
import { AutomationScanSection } from "../components/stores/AutomationScanSection";
import { AutomationScopeSection } from "../components/stores/AutomationScopeSection";
import { AutoSyncSection } from "../components/stores/AutoSyncSection";
import { StoreDirectorySection } from "../components/stores/StoreDirectorySection";
import { BrandTreeSection } from "../components/stores/BrandTreeSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface StoresPageProps {
  model: OpsConsoleModel;
}

export function StoresPage({ model }: StoresPageProps) {
  return (
    <OpsPage
      eyebrow="STORE OPERATIONS"
      title="店铺管理"
      description="按平台和店铺管理授权、同步与自动化策略。"
    >
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <BrandTreeSection brands={model.brandNavigation} />
      <StoreDirectorySection
        storeDirectory={model.storeDirectory}
        canPlatformOps={model.canPlatformOps}
        onSaveAlias={model.saveStoreAlias}
        onRevoke={model.revokeStore}
      />
      <AutomationScopeSection
        storeDirectory={model.storeDirectory}
        selectedAutomationStore={model.selectedAutomationStore}
        automationScope={model.automationScope}
        canQueue={model.canQueue}
        onLoadScope={model.loadAutomationScope}
      />
      <AutomationPolicySection automationPolicies={model.automationPolicies} />
      <AutomationScanSection
        automationPolicy={model.automationPolicy}
        automationScan={model.automationScan}
        canQueue={model.canQueue}
        setAutomationPolicy={model.setAutomationPolicy}
        onScan={model.scanAutomation}
        onUpdate={model.updateAutomation}
      />
      <AutoSyncSection
        automationPolicy={model.automationPolicy}
        selectedAutomationStore={model.selectedAutomationStore}
        canQueue={model.canQueue}
        onUpdateSync={model.updateAutomationSync}
        onUpdate={model.updateAutomation}
      />
    </OpsPage>
  );
}
