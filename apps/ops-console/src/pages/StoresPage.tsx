import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AutomationPolicySection } from "../components/stores/AutomationPolicySection";
import { AutomationScanSection } from "../components/stores/AutomationScanSection";
import { PlatformSummarySection } from "../components/stores/PlatformSummarySection";
import { StoreDirectorySection } from "../components/stores/StoreDirectorySection";
import { BrandTreeSection } from "../components/stores/BrandTreeSection";
import { BrandGovernanceSummary } from "../components/stores/BrandGovernanceSummary";
import { CanonicalProductConsistencySection } from "../components/stores/CanonicalProductConsistencySection";
import { CanonicalBackfillConflictSection } from "../components/stores/CanonicalBackfillConflictSection";
import { opsRestPost, rpc } from "../api/opsClient.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { platformLabels, platforms, type Platform } from "../types/ops";
import type { OpsDomain } from "../navigation/opsNavigation";
import { Button } from "antd";

interface StoresPageProps {
  model: OpsConsoleModel;
}

export async function openBrandStore(
  model: Pick<OpsConsoleModel, "setQueueFilters" | "load">,
  onNavigate: (domain: OpsDomain) => void,
  platform: string,
  accountId: string,
) {
  if (!platforms.includes(platform as Platform)) return false;
  const queueFilters = { platform: platform as Platform, accountId };
  model.setQueueFilters(queueFilters);
  onNavigate("tasks");
  await model.load({ queueFilters });
  return true;
}

/** Keep the empty-state brand create affordance aligned with the server's
 * role gate. Content editors may update brand-owned content, but only these
 * workspace roles may create the brand-unit aggregate itself. */
export function canCreateBrandUnit(roles: readonly string[]) {
  return roles.some((role) => ["workspace_owner", "merchant_admin", "platform_ops"].includes(role));
}

export function StoresPage({ model, onNavigate }: StoresPageProps & { onNavigate: (domain: OpsDomain) => void }) {
  const storeLoadError = model.dataSetError("workspace.health", "ops.stores.list");
  const platformScope = model.authorization.scope.kind === "platform";
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
      {!platformScope && <BrandTreeSection brands={model.brandNavigation} canRead={canCanonicalRead} canCreate={canCreateBrand} stores={model.storeDirectory} canBind={model.authorization.can("customer.content.update")} loading={model.loading} error={storeLoadError} onRetry={() => void model.load()} onOpenStore={(platform, accountId) => void openBrandStore(model, onNavigate, platform, accountId)} onCreateBrand={model.createBrand} onBindStore={async ({ brandId, platform, accountId, expectedRevision }) => {
        await rpc("brand-unit.bind-store", { brand_id: brandId, platform, account_id: accountId, ...(expectedRevision !== undefined ? { expected_revision: String(expectedRevision) } : {}), reason: "运营台绑定品牌与已授权平台店铺" });
        await model.load();
        return true;
      }} />}
      <BrandGovernanceSummary summary={model.platformBrandUnitSummary} />
      <CanonicalProductConsistencySection report={model.canonicalProductConsistency} onRefresh={() => void model.load()} loading={model.loading} canRead={canCanonicalRead} />
      <CanonicalBackfillConflictSection enabled={platformScope && model.authorization.can("canonical.backfill.read")} canUpdate={platformScope && model.authorization.can("canonical.backfill.update")} brands={model.brandNavigation} onScan={platformScope && canCanonicalRead ? async () => {
        const run = await rpc<{ id: string }>("ops.canonical.backfill.create", { dry_run: "true", reason: "刷新 canonical 冲突队列前创建扫描审计批次" });
        if (!run?.id) throw new Error("扫描审计批次创建失败");
        await opsRestPost("/v1/canonical-backfill/conflicts/scan", { audit_batch_id: run.id, reason: "刷新 canonical 冲突队列" });
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
      />
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
