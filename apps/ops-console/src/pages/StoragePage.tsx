import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { StorageReconciliationSection } from "../components/storage/StorageReconciliationSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface StoragePageProps { model: OpsConsoleModel }

export function StoragePage({ model }: StoragePageProps) {
  const storageError = model.dataSetError("ops.storage.reconciliation.list");
  return (
    <OpsPage eyebrow="STORAGE & RECONCILIATION" title="存储与对账" description="按 workspace 查看容量、对象引用一致性和对账新鲜度；客户对象内容与下载入口不在运营台展示。">
      <OpsPageError error={storageError ?? ""} onRetry={() => void model.load()} />
      <StorageReconciliationSection loading={model.loading} error={storageError} summary={model.workspaceMetrics?.storageReconciliation} summaries={model.storageReconciliationWorkspaces} />
    </OpsPage>
  );
}
