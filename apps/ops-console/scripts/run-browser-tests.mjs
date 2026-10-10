import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const files = [
  "src/pages/OverviewPage.browser.test.tsx",
  "src/navigation/OpsNavigation.browser.test.tsx",
  "src/components/OpsPageError.browser.test.tsx",
  "src/components/support/SupportQueueSection.row-interaction.browser.test.tsx",
  "src/components/commercial/CommercialRefundOperationsPanel.browser.test.tsx",
  "src/components/commercial/PointAdjustmentPanel.browser.test.tsx",
  "src/pages/OpsConsoleController.identity-route.browser.test.tsx",
  "src/components/finance/RefundSection.validation.browser.test.tsx",
  "src/components/OpsHeader.test.tsx",
  "src/components/delivery/CustomerDeliveryTrainingToggle.test.tsx",
  "src/components/delivery/CustomerDeliveryUpload.test.tsx",
  "src/components/finance/MembersSection.session-boundary.test.tsx",
  "src/components/users/AuthorizationGovernanceSection.test.tsx",
  "src/components/users/RegistrationApplications.test.tsx",
  "src/components/users/WorkspaceGovernanceSection.browser.test.tsx",
  "src/components/users/UsersGovernanceDenied.browser.test.tsx",
  "src/hooks/alertPollingBoundary.test.tsx",
  "src/hooks/useOpsConsoleModel.workspaceDirectory.test.tsx",
  "src/pages/CustomerDeliveryPage.test.tsx",
  "src/pages/CustomerDeliveryPage.restore.browser.regression.test.tsx",
  "src/pages/CustomerDeliveryAuthorizationWorkspace.e2e.test.ts",
  "src/pages/customer-delivery-workspace-race.test.tsx",
];

for (const file of files) {
  // This real Chromium/Vite harness compiles the page on its first navigation.
  // Keep its tenant/permission assertions in the browser lane and give each
  // navigation a bounded browser budget instead of the five-second unit limit.
  const browserBudget = file === "src/pages/CustomerDeliveryAuthorizationWorkspace.e2e.test.ts"
    ? ["--testTimeout=30000"] : [];
  const result = spawnSync(process.execPath, [vitest, "run", "--pool=threads", "--no-file-parallelism", ...browserBudget, file], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
