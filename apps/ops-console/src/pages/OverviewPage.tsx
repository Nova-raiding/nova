import { OpsPage } from "../components/OpsPage";
import { PlatformOverviewSnapshot } from "../components/sections/overview/PlatformOverviewSnapshot";
import { CommercialOverviewSection } from "../components/sections/overview/CommercialOverviewSection.js";
import { OperationalAlertsPanel } from "../components/sections/overview/PlatformReadinessSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../navigation/opsNavigation";

interface OverviewPageProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
  onNavigateWithQuery?: (domain: OpsDomain, query: Record<string, string | undefined>) => void;
}

export function OverviewPage({ model, onNavigate, onNavigateWithQuery }: OverviewPageProps) {
  return (
    <OpsPage
      title="运营总览"
    >
      <div className="ops-overview-page">
        <PlatformOverviewSnapshot model={model} onNavigate={onNavigate} />
        <CommercialOverviewSection model={model} onNavigate={onNavigate} onNavigateWithQuery={onNavigateWithQuery} />
        {/* The alert panel was previously reachable from no route, so the
            delivery state of an alert — the only signal that the alert
            channel itself is broken — was rendered nowhere in the console. */}
        <OperationalAlertsPanel model={model} />
      </div>
    </OpsPage>
  );
}
