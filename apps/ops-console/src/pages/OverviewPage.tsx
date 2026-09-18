import { OpsPage } from "../components/OpsPage";
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
      hideTitle
    >
      <div className="ops-overview-page">
        <PlatformOverviewSnapshot model={model} onNavigate={onNavigate} />
      </div>
    </OpsPage>
  );
}
