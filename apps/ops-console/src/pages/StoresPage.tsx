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

export function StoresPage({ model, onNavigate }: StoresPageProps & { onNavigate: (domain: OpsDomain) => void }) {
  const storeLoadError = model.dataSetError("workspace.health", "ops.stores.list");
  const platformScope = model.authorization.scope.kind === "platform";
  const storeDetailError = storeLoadError && model.storeDirectory.length === 0 ? storeLoadError : undefined;
  const hasAutomationData = Boolean(model.automationPolicy || model.automationScan || model.automationPolicies.length);
  const automationLoadError = model.dataSetError("automation.policy.get", "automation.policy.list", "automation.scan");
  const automationError = automationLoadError && !hasAutomationData ? automationLoadError : undefined;
  const canCanonicalRead = model.authorization.can("customer.content.read");

  return (
    <OpsPage
      eyebrow="STORE OPERATIONS"
      title="平台连接汇总"
      description="平台运营查看平台级连接健康，并通过受控支持入口处理客户问题。"
    >
      <OpsPageError error={storeLoadError || automationLoadError || ""} onRetry={() => void model.load()} />
      <PlatformSummarySection stores={model.storeDirectory} loading={model.loading} error={storeLoadError} onRetry={() => void model.load()} onOpenSupport={() => onNavigate("support")} platformLabels={platformLabels} />
      {!platformScope && <BrandTreeSection brands={model.brandNavigation} canRead={canCanonicalRead} canCreate={model.authorization.can("customer.content.update")} stores={model.storeDirectory} canBind={model.authorization.can("customer.content.update")} loading={model.loading} error={storeLoadError} onRetry={() => void model.load()} onOpenStore={(platform, accountId) => void openBrandStore(model, onNavigate, platform, accountId)} onCreateBrand={model.createBrand} onBindStore={async ({ brandId, platform, accountId, expectedRevision }) => {
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
    </OpsPage>
  );
}
