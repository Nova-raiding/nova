import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { StorageReconciliationSection } from "../components/storage/StorageReconciliationSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { Alert, Button } from "antd";

interface StoragePageProps { model: OpsConsoleModel }

export function StoragePage({ model }: StoragePageProps) {
  // This page is reachable with `workspace.summary.read` alone, but the
  // platform-wide workspace reconciliation list is gated on
  // `storage.reconciliation.read`. Without it the list is never requested, and
  // its empty state would tell the operator to go run the reconciliation job -
  // an instruction for a capability the session does not have, about data that
  // was never read.
  const canReadPlatformReconciliation = model.authorization.can("storage.reconciliation.read");
  const storageError = model.dataSetError("ops.storage.reconciliation.list");
  return (
    <OpsPage eyebrow="STORAGE & RECONCILIATION" title="存储与对账" description="按 workspace 查看容量、对象引用一致性和对账新鲜度；客户对象内容与下载入口不在运营台展示。" actions={<Button type="primary" loading={model.loading} onClick={() => void model.load()}>刷新存储</Button>}>
      <div className="ops-storage-page">
        <OpsPageError error={storageError ?? ""} onRetry={() => void model.load()} />
        {!canReadPlatformReconciliation ? (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            title="当前会话没有平台存储对账读取权限"
            description="这不是空结果；平台级 workspace 对账列表需要 storage.reconciliation.read，未授权时本页不会发起该读取。下面的空列表只代表没有读取到平台数据，不能解读为对账任务未运行。"
          />
        ) : null}
        <StorageReconciliationSection loading={model.loading} error={storageError} fixtureDataPresent={model.dataSource?.fixtureDataPresent} onRetry={() => void model.load()} summary={model.workspaceMetrics?.storageReconciliation} summaries={model.storageReconciliationWorkspaces} />
      </div>
    </OpsPage>
  );
}
