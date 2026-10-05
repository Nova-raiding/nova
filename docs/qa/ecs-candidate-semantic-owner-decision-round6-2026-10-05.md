# Three-way semantic owner decision matrix — round 6 (2026-10-05)

This is a candidate-bound **unresolved** matrix. It does not approve a merge or deployment.

- Candidate: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Trusted base / merge-base: `85575f9c257c5186116e16fc0bde58d25c25f8ed`
- Source: `docs/qa/ecs-candidate-three-way-round5-2026-10-05.json`
- Rows requiring owner decision: **103** (39 candidate-only, 64 byte-clean)
- Approved: **0**

## Decision rule

A byte-clean merge and a candidate-only classification establish only byte-level facts. A legal semantic decision requires an authenticated owner identity, an attestation bound to the exact candidate and path, a rationale, and recorded checks. None is present in the current workspace, so every row remains `UNRESOLVED`.

## Required owner evidence

The owner must record `owner_identity`, `owner_attestation`, `attested_at`, `decision` (`PRESERVE_REMOTE`, `TAKE_CANDIDATE`, or `MANUAL_MERGE`), rationale, and checks run. Until then, `approved=false` is invariant.

| Class | Count | Decision |
|---|---:|---|
| candidate-only | 39 | unresolved |
| byte-clean | 64 | unresolved |

## Per-path matrix

| Path | Class | Merge result | Suggested owner | Remote bytes persisted | Decision |
|---|---|---|---|---:|---|
| `apps/api/src/scanner-health.test.ts` | `double_change` | `clean` | `platform-runtime-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/.env.example` | `candidate_only` | `not_applicable` | `ops-console-owner` | no | `UNRESOLVED` |
| `apps/ops-console/README.md` | `candidate_only` | `not_applicable` | `ops-console-owner` | no | `UNRESOLVED` |
| `apps/ops-console/src/api/commercialOperationsClient.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/api/opsDomainClients.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/authz/authorization.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/authz/authorization.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/OpsHeader.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/PlatformOpsLoginPage.test.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/audit/AuditCenterSection.test.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/authz/AccessDeniedResult.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/authz/DangerActionModal.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/authz/RoleScopeBar.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/authz/permissionUx.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/canonical-governance-accessibility.test.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/commercial/CommercialReadinessPanel.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/commercial/ServiceFulfillmentPanel.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/commercial/benefitLabels.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/delivery/CustomerDeliveryUpload.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/delivery/deliveryDateTime.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/delivery/deliveryDateTime.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/FinanceDetailDrawer.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/FinanceSearchSection.test.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/FinanceSearchSection.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/MembersSection.test.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/MembersSection.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/RechargeOrdersSection.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/RechargeOrdersSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/ReconciliationSection.test.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/ReconciliationSection.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/RefundSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/rechargeOrders.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/finance/rechargeOrders.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/models/ModelReadinessTable.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/models/ModelServiceSummary.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/models/ModelServiceSummary.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/models/ModelStatusSection.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/models/ModelStatusSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/rules/RuleSyncStatusSection.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/rules/WorkspaceRuleAuditPanel.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/sections/overview/DataReadinessSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/sections/overview/modelReadiness.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/sections/overview/modelReadiness.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/storage/StorageReconciliationSection.test.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/storage/StorageReconciliationSection.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/AutomationScanSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/BrandGovernanceSummary.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/CanonicalBackfillConflictSection.test.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/CanonicalBackfillConflictSection.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/CanonicalProductConsistencySection.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/CanonicalProductConsistencySection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/PlatformSummarySection.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/stores/StoreDirectorySection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/support/SupportSlaReportSection.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/support/SupportSlaReportSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/tasks/KnowledgeGovernanceSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/tasks/OperationalGovernanceSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/tasks/knowledge/AssetRightsPanel.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/tasks/knowledge/CompetitorReferencesPanel.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/tasks/knowledge/KnowledgeRulesPanel.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/tasks/knowledge/LearningSuggestionsPanel.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/components/users/PermissionMatrixSection.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/opsLoadCoordinator.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/opsLoadCoordinator.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useAuditCenter.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useAuditCenter.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useCommercialOperations.test.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useFinanceSearch.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useFinanceSearch.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useMembers.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useMembers.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/hooks/useSupportDomain.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/navigation/opsPageRegistry.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/navigation/useOpsNavigation.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/pages/AuditPage.test.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/pages/MembersPage.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/pages/OpsConsoleController.test.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/pages/OverviewPage.test.tsx` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/pages/StoragePage.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/pages/UsersPage.test.tsx` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/pages/modelsPageVisibility.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/src/types/ops.ts` | `double_change` | `clean` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/ops-console/vite.config.ts` | `candidate_only` | `not_applicable` | `ops-console-owner` | yes | `UNRESOLVED` |
| `apps/worker/src/scanner-heartbeat.ts` | `double_change` | `clean` | `platform-runtime-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/entry-points.test.ts` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | no | `UNRESOLVED` |
| `demo/merchant-studio/src/CampaignLifecyclePanel.tsx` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/CanonicalConsistencyPanel.tsx` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/ContextRecoveryCard.tsx` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/DeliveryReadinessPanel.tsx` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/MerchantLoginPage.tsx` | `double_change` | `clean` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/detail-sop.test.ts` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/detail-sop.ts` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/knowledge-consumption.test.ts` | `double_change` | `clean` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/main.tsx` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/navigation-cleanup.test.ts` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/platform-connection-status.test.ts` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/platform-connection-status.ts` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/src/task-visual-contract.test.ts` | `double_change` | `clean` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `demo/merchant-studio/tsconfig.node.json` | `candidate_only` | `not_applicable` | `merchant-studio-owner` | yes | `UNRESOLVED` |
| `packages/workers/src/scanner-heartbeat.test.ts` | `double_change` | `clean` | `platform-runtime-owner` | yes | `UNRESOLVED` |
| `packages/workers/src/scanner-heartbeat.ts` | `double_change` | `clean` | `platform-runtime-owner` | yes | `UNRESOLVED` |

No remote file, candidate file, or host state was modified while producing this matrix.
