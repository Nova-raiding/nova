import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AutomationPolicySection } from "../components/stores/AutomationPolicySection";
import { AutomationScanSection } from "../components/stores/AutomationScanSection";
import { PlatformSummarySection } from "../components/stores/PlatformSummarySection";
import { StoreDirectorySection } from "../components/stores/StoreDirectorySection";
import { PlatformManualProductImport } from "../components/stores/PlatformManualProductImport";
import { BrandTreeSection } from "../components/stores/BrandTreeSection";
import { BrandGovernanceSummary } from "../components/stores/BrandGovernanceSummary";
import { CanonicalProductConsistencySection } from "../components/stores/CanonicalProductConsistencySection";
import { CanonicalBackfillConflictSection } from "../components/stores/CanonicalBackfillConflictSection";
import { opsRestPost } from "../api/opsClient.js";
import { rpc, rpcForWorkspace } from "../api/opsClient.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { platformLabels } from "../types/ops";
import type { OpsDomain } from "../navigation/opsNavigation";
import { openBrandStore } from "./brandStoreTaskNavigation.js";
export { openBrandStore } from "./brandStoreTaskNavigation.js";
import { Button } from "antd";
import { useState } from "react";

interface StoresPageProps {
  model: OpsConsoleModel;
}

/** Keep the empty-state brand create affordance aligned with the server's
 * role gate. Content editors may update brand-owned content, but only these
 * workspace roles may create the brand-unit aggregate itself. */
export function canCreateBrandUnit(roles: readonly string[]) {
  return roles.some((role) => ["workspace_owner", "merchant_admin", "platform_ops"].includes(role));
}

export function canScanCanonicalBackfill(platformScope: boolean, canUpdate: boolean, updateScope?: string) {
  return platformScope && canUpdate && updateScope === "platform";
}

export function StoresPage({ model, onNavigate, onNavigateWithQuery }: StoresPageProps & { onNavigate: (domain: OpsDomain) => void; onNavigateWithQuery?: (domain: OpsDomain, query: Record<string, string | undefined>) => void }) {
  const [conflictWorkspaceId, setConflictWorkspaceId] = useState("");
  const storeLoadError = model.dataSetError("workspace.health", "ops.stores.list");
  const platformScope = model.authorization.scope.kind === "platform";
  const canManageCanonicalBackfill = platformScope && model.authorization.can("canonical.backfill.read");
  const canUpdateCanonicalBackfill = canScanCanonicalBackfill(
    platformScope,
    model.authorization.can("canonical.backfill.update"),
    model.authorization.scopeFor("canonical.backfill.update")?.kind,
  );
  const storeDetailError = storeLoadError && model.storeDirectory.length === 0 ? storeLoadError : undefined;
  const hasAutomationData = Boolean(model.automationPolicy || model.automationScan || model.automationPolicies.length);
  const automationLoadError = model.dataSetError("automation.policy.get", "automation.policy.list", "automation.scan");
  const automationError = automationLoadError && !hasAutomationData ? automationLoadError : undefined;
  const canCanonicalRead = model.authorization.can("customer.content.read");
  const canCreateBrand = canCreateBrandUnit(model.authorization.roles);

  return (
    <OpsPage
      eyebrow="STORE OPERATIONS"
      title="平台连接汇总"
      description="平台运营查看平台级连接健康。"
      actions={<Button type="primary" loading={model.loading} onClick={() => void model.load()}>刷新连接</Button>}
    >
      <div className="ops-stores-page">
      <OpsPageError error={storeLoadError || automationLoadError || ""} onRetry={() => void model.load()} />
      <PlatformSummarySection stores={model.storeDirectory} loading={model.loading} error={storeLoadError} onRetry={() => void model.load()} platformLabels={platformLabels} />
      {!platformScope && <BrandTreeSection brands={model.brandNavigation} canRead={canCanonicalRead} canCreate={canCreateBrand} stores={model.storeDirectory} canBind={model.authorization.can("customer.content.update")} loading={model.loading} error={storeLoadError} onRetry={() => void model.load()} onOpenStore={(platform, accountId) => void openBrandStore(model, onNavigate, platform, accountId, onNavigateWithQuery)} onCreateBrand={model.createBrand} onBindStore={async ({ brandId, platform, accountId, expectedRevision }) => {
        await rpc("brand-unit.bind-store", { brand_id: brandId, platform, account_id: accountId, ...(expectedRevision !== undefined ? { expected_revision: String(expectedRevision) } : {}), reason: "运营台绑定品牌与已授权平台店铺" });
        await model.load();
        return true;
      }} />}
      <BrandGovernanceSummary summary={model.platformBrandUnitSummary} />
      <CanonicalProductConsistencySection report={model.canonicalProductConsistency} onRefresh={() => void model.load()} loading={model.loading} canRead={canCanonicalRead} />
      <CanonicalBackfillConflictSection enabled={canManageCanonicalBackfill} canUpdate={canUpdateCanonicalBackfill} brands={model.brandNavigation} workspaces={(model.workspaceDirectory?.items ?? []).filter(workspace => workspace.status === "active")} workspaceId={conflictWorkspaceId} onWorkspaceChange={setConflictWorkspaceId} onScan={canUpdateCanonicalBackfill ? async (workspaceId) => {
        const run = await rpc<{ id: string }>("ops.canonical.backfill.create", { workspace_id: workspaceId, dry_run: "true", reason: "刷新 canonical 冲突队列前创建扫描审计批次" });
        if (!run?.id) throw new Error("扫描审计批次创建失败");
        await opsRestPost("/v1/canonical-backfill/conflicts/scan", { workspace_id: workspaceId, audit_batch_id: run.id, reason: "刷新 canonical 冲突队列" });
        await model.load();
      } : undefined} />
      <StoreDirectorySection
        storeDirectory={model.storeDirectory}
        canPlatformOps={model.canPlatformOps}
        loading={model.loading}
        error={storeDetailError}
        onRetry={() => void model.load()}
        onSaveAlias={model.saveStoreAlias}
        onRevoke={model.revokeStore}
        workspaces={model.workspaceDirectory?.items ?? []}
        onRegisterManualStore={async ({ workspaceId, platform, accountId, storeAlias, reason }) => {
          const response = await rpcForWorkspace<{ connection?: { mode?: string; token_state?: string; credential_free?: boolean; authorization_receipt?: unknown }; applies_to_store_boundary?: boolean }>(workspaceId, "ops.platform.store.record.create", {
            workspace_id: workspaceId, platform, account_id: accountId, ...(storeAlias ? { store_alias: storeAlias } : {}), reason,
          });
          if (response?.connection?.mode !== "manual_store_record" || response?.connection?.token_state !== "manually_registered" || response?.connection?.credential_free !== true || response?.connection?.authorization_receipt !== null || typeof response?.applies_to_store_boundary !== "boolean") {
            throw new Error("人工店铺登记未返回有效的创建结果和边界策略状态");
          }
          await model.load();
          return response.applies_to_store_boundary;
        }}
      />
      {platformScope && model.authorization.can("customer.manual_import") && <PlatformManualProductImport workspaces={model.workspaceDirectory?.items ?? []} />}
      <AutomationPolicySection
        automationPolicies={model.automationPolicies}
        loading={model.loading}
        error={automationError}
        onRetry={() => void model.load()}
      />
      <AutomationScanSection
        automationPolicy={model.automationPolicy}
        automationScan={model.automationScan}
        canQueue={model.canQueue}
        loading={model.loading}
        error={automationError}
        onRetry={() => void model.load()}
        setAutomationPolicy={model.setAutomationPolicy}
        onScan={model.scanAutomation}
        onUpdate={model.updateAutomation}
      />
      </div>
    </OpsPage>
  );
}
