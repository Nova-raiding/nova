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
  "src/pages/CustomerDeliveryPage.archive-conflict.browser.test.tsx",
  "src/pages/CustomerDeliveryAuthorizationWorkspace.e2e.test.ts",
  "src/pages/customer-delivery-workspace-race.test.tsx",
  "src/components/AsyncMutationState.browser.test.tsx",
  "src/components/OpsSearchPagination.browser.test.tsx",
  "src/components/audit/AuditExportTruncation.browser.test.tsx",
  "src/components/commercial/AssistedPurchaseOperationsPanel.browser.test.tsx",
  "src/components/delivery/CustomerDeliveryAccountBinding.search.browser.test.tsx",
  "src/components/delivery/CustomerDeliverySection.pagination.browser.test.tsx",
  "src/components/finance/FinanceSearchSection.advanced-filter.browser.test.tsx",
  "src/pages/FinancePage.error-recovery.browser.test.tsx",
  "src/components/rules/RuleSyncStatusSection.retry.browser.test.tsx",
  "src/components/stores/StoreDirectorySection.boundary-result.browser.test.tsx",
  "src/components/stores/StoreDirectorySection.registration-error.browser.test.tsx",
  "src/components/stores/StoreDirectorySection.revoke-confirmation.browser.test.tsx",
  "src/components/support/PlatformSupportWorkspace.paging.browser.test.tsx",
  "src/components/support/PlatformSupportWorkspace.reply-recovery.browser.test.tsx",
  "src/components/support/SupportQueueSection.create-failure.browser.test.tsx",
  "src/components/support/SupportQueueSection.whitespace-validation.browser.test.tsx",
  "src/components/support/SupportTicketDetailSection.fetch-recovery.browser.test.tsx",
  "src/components/support/SupportTicketDetailSection.action-feedback.browser.test.tsx",
  "src/components/support/SupportTicketDetailSection.status-transitions.browser.test.tsx",
  "src/components/tasks/RuleCenterSection.activation-validation.browser.test.tsx",
  "src/components/tasks/knowledge/CampaignLifecycleControl.retry.browser.test.tsx",
  "src/components/users/AuthorizationGovernanceModelTarget.browser.test.tsx",
  "src/components/users/AuthorizationGovernanceScope.browser.test.tsx",
  "src/components/users/UserDirectorySection.provision-workspace-search.browser.test.tsx",
  "src/hooks/useFinanceSearch.pagination.browser.test.tsx",
  "src/hooks/useFinanceSearch.stale-results.browser.test.tsx",
  "src/hooks/useSupportDomain.filter-refresh.browser.test.tsx",
  "src/hooks/useSupportDomain.mutation-navigation.browser.test.tsx",
  "src/hooks/useSupportDomain.mutation-refresh.browser.test.tsx",
  "src/hooks/useSupportDomain.selection.browser.test.tsx",
  "src/hooks/useSupportDomain.uncertain-mutation.browser.test.tsx",
  "src/navigation/useOpsNavigation.unsaved.browser.test.tsx",
  "src/pages/BrandStoreTasksDeepLink.browser.test.tsx",
  "src/pages/CustomerDeliveryCreateFlow.e2e.test.ts",
  "src/pages/AuditPage.browser.journey.test.tsx",
  "src/pages/IncidentsPage.error.browser.test.tsx",
  "src/pages/ModelsPage.overview-navigation.browser.test.tsx",
  "src/pages/OpsConsoleController.access-denied-recovery.e2e.test.ts",
  "src/pages/StoragePage.error.browser.test.tsx",
  "src/components/storage/StorageReconciliationSection.paging.browser.test.tsx",
  "src/pages/StoresPage.brand-binding.browser.test.tsx",
  "src/pages/SupportPage.error.browser.test.tsx",
  "src/pages/customer-delivery-session-loss.e2e.test.ts",
]

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
