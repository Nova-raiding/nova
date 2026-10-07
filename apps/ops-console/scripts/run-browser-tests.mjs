import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const files = [
  "src/components/OpsHeader.test.tsx",
  "src/components/delivery/CustomerDeliveryTrainingToggle.test.tsx",
  "src/components/delivery/CustomerDeliveryUpload.test.tsx",
  "src/components/finance/MembersSection.session-boundary.test.tsx",
  "src/components/users/AuthorizationGovernanceSection.test.tsx",
  "src/components/users/RegistrationApplications.test.tsx",
  "src/components/users/WorkspaceGovernanceSection.browser.test.tsx",
  "src/hooks/alertPollingBoundary.test.tsx",
  "src/hooks/useOpsConsoleModel.workspaceDirectory.test.tsx",
  "src/pages/CustomerDeliveryPage.test.tsx",
  "src/pages/customer-delivery-workspace-race.test.tsx",
];

for (const file of files) {
  const result = spawnSync(process.execPath, [vitest, "run", "--pool=threads", "--no-file-parallelism", file], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
