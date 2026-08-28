import { Suspense } from "react";
import { App as AntApp, Layout, Skeleton } from "antd";
import { OpsHeader } from "../components/OpsHeader";
import { OpsSidebar } from "../components/OpsSidebar";
import { useOpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { useOpsNavigation } from "../navigation/useOpsNavigation";
import { opsPageRegistry } from "../navigation/opsPageRegistry.js";
import { platformLabels } from "../types/ops";
import { managedOpsSession } from "../api/opsClient";

const { Content } = Layout;

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
        onSelectStore={(scope) => {
          model.setSelectedStoreScope(scope);
          model.setAutomationScope(scope);
        }}
      />
      <Layout>
        <OpsHeader
          managedSession={managedOpsSession}
          roles={model.opsSession?.roles}
          sessionLoaded={Boolean(model.opsSession)}
          onRefresh={() => {
            void model.load();
            void model.loadModelMarkup();
          }}
        />
        <Content className="ops-content">
          <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
            <ActivePage model={model} />
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
