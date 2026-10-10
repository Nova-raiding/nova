import { OpsPage } from "../components/OpsPage";
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
  const canReadPlatformReconciliation = model.authorization.scope.kind === "platform"
    && model.authorization.can("storage.reconciliation.read");
  const canRefreshPageData = canReadPlatformReconciliation || model.authorization.can("workspace.summary.read");
  const storageError = canReadPlatformReconciliation ? model.dataSetError("ops.storage.reconciliation.list") : undefined;
  return (
    <OpsPage eyebrow="STORAGE & RECONCILIATION" title="存储与对账" description="按 workspace 查看容量、对象引用一致性和对账新鲜度；客户对象内容与下载入口不在运营台展示。" actions={canRefreshPageData ? <Button type="primary" loading={model.loading} style={{ minWidth: 110 }} onClick={() => void model.load()}>{canReadPlatformReconciliation ? "刷新存储" : "刷新存储摘要"}</Button> : undefined}>
      <div className="ops-storage-page">
        {!canReadPlatformReconciliation ? (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            title="当前会话没有平台存储对账读取权限"
            description="平台级 workspace 对账列表需要 storage.reconciliation.read；未授权时不会发起读取。当前空白或破折号不代表用量为零、对账未运行或状态正常。"
          />
        ) : null}
        <StorageReconciliationSection
          loading={model.loading}
          error={storageError}
          fixtureDataPresent={model.dataSource?.fixtureDataPresent}
          onRetry={canReadPlatformReconciliation ? () => void model.load() : undefined}
          unavailableReason={!canReadPlatformReconciliation ? "本次平台列表读取未执行。空白或破折号不能说明存储用量为零、对账未运行或状态正常；请联系平台管理员申请 storage.reconciliation.read。" : undefined}
          summary={model.workspaceMetrics?.storageReconciliation}
          summaries={model.storageReconciliationWorkspaces}
        />
      </div>
    </OpsPage>
  );
}
