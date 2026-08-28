import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import type { OpsDomain } from "./opsNavigation.js";
import { UsersPage } from "../pages/UsersPage.js";

export interface OpsDomainPageProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

type OpsDomainPage = LazyExoticComponent<ComponentType<OpsDomainPageProps>>;

export const opsPageRegistry: Record<OpsDomain, OpsDomainPage> = {
  overview: lazy(() =>
    import("../pages/OverviewPage.js").then(({ OverviewPage }) => ({ default: OverviewPage })),
  ),
  // Keep the platform safety surface immediately available. A pending route
  // chunk must never block account suspension during an incident.
  users: lazy(async () => ({ default: UsersPage })),
  tasks: lazy(() =>
    import("../pages/TasksPage.js").then(({ TasksPage }) => ({ default: TasksPage })),
  ),
  stores: lazy(() =>
    import("../pages/StoresPage.js").then(({ StoresPage }) => ({ default: StoresPage })),
  ),
  models: lazy(() =>
    import("../pages/ModelsPage.js").then(({ ModelsPage }) => ({ default: ModelsPage })),
  ),
  finance: lazy(() =>
    import("../pages/FinancePage.js").then(({ FinancePage }) => ({ default: FinancePage })),
  ),
};
