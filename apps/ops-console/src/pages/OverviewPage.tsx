import { OpsPage } from "../components/OpsPage";
import { PlatformOverviewSnapshot } from "../components/sections/overview/PlatformOverviewSnapshot";
import { OperationalAlertsPanel } from "../components/sections/overview/PlatformReadinessSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../navigation/opsNavigation";

interface OverviewPageProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export function OverviewPage({ model, onNavigate }: OverviewPageProps) {
  return (
    <OpsPage
      title="运营总览"
      hideTitle
    >
      <div className="ops-overview-page">
        <PlatformOverviewSnapshot model={model} onNavigate={onNavigate} />
        {/* The alert panel was previously reachable from no route, so the
            delivery state of an alert — the only signal that the alert
            channel itself is broken — was rendered nowhere in the console. */}
        <OperationalAlertsPanel model={model} />
      </div>
    </OpsPage>
  );
}
