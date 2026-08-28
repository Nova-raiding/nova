import { Suspense } from "react";
import { App as AntApp, Layout, Skeleton } from "antd";
import { OpsHeader } from "../components/OpsHeader";
import { OpsSidebar } from "../components/OpsSidebar";
import { useOpsConsoleModel, type OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { useOpsNavigation } from "../navigation/useOpsNavigation";
import { opsPageRegistry } from "../navigation/opsPageRegistry.js";
import { platformLabels } from "../types/ops";
import { managedOpsSession } from "../api/opsClient";

const { Content } = Layout;

export async function selectStoreScope(
  model: Pick<OpsConsoleModel, "setSelectedStoreScope" | "loadAutomationScope">,
  scope: string,
) {
  model.setSelectedStoreScope(scope);
  return model.loadAutomationScope(scope);
}

function Dashboard() {
  const model = useOpsConsoleModel();
  const { activeDomain, navigate: navigateToDomain } = useOpsNavigation();
  const ActivePage = opsPageRegistry[activeDomain];

  return (
    <Layout className="ops-shell">
      <OpsSidebar
        activeDomain={activeDomain}
        stores={model.storeDirectory}
        platformLabels={platformLabels}
        selectedStoreScope={model.selectedStoreScope}
        onNavigate={navigateToDomain}
        onSelectStore={(scope) => selectStoreScope(model, scope)}
      />
      <Layout>
        <OpsHeader
          managedSession={managedOpsSession}
          roles={model.opsSession?.roles}
          sessionLoaded={Boolean(model.opsSession)}
          dataSource={model.dataSource}
          onRefresh={() => {
            void model.load();
            void model.loadModelMarkup();
          }}
        />
        <Content className="ops-content">
          <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
            <ActivePage model={model} onNavigate={navigateToDomain} />
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  );
}

export function OpsConsoleController() {
  return (
    <AntApp>
      <Dashboard />
    </AntApp>
  );
}
