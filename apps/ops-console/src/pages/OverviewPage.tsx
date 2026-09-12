import { OpsPage } from "../components/OpsPage";
import { CommercialOverviewSection } from "../components/sections/overview/CommercialOverviewSection";
import { ModelServiceSummary } from "../components/models/ModelServiceSummary";
import { PlatformOverviewSnapshot } from "../components/sections/overview/PlatformOverviewSnapshot";
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
    >
      <div className="ops-overview-page">
        <PlatformOverviewSnapshot model={model} onNavigate={onNavigate} />
        <CommercialOverviewSection model={model} onNavigate={onNavigate} />
        <div style={{ marginTop: 16 }}>
          <ModelServiceSummary
            status={model.modelStatus}
            loading={model.modelStatusLoading}
            onOpen={() => onNavigate("models")}
          />
        </div>
      </div>
    </OpsPage>
  );
}
