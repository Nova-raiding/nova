import { Alert, Button } from "antd";
import { useEffect, useState } from "react";
import { OpsPage } from "../components/OpsPage.js";
import { CustomerDeliverySection } from "../components/delivery/CustomerDeliverySection.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import { customerDeliveryClient } from "../api/customerDeliveryClient.js";
import { describeOpsError } from "../api/opsClient.js";

export function CustomerDeliveryPage({ model }: { model: OpsConsoleModel }) {
  const canRead = model.authorization.can("customer.delivery.read") || model.authorization.can("workspace.directory.read");
  const [records, setRecords] = useState<import("../components/delivery/CustomerDeliverySection.js").CustomerDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    if (!canRead) return;
    setLoading(true); setError("");
    try { const result = await customerDeliveryClient.list(); if (result === null) throw new Error("客户交付 API 未返回数据"); setRecords(result); }
    catch (cause) { setRecords([]); setError(describeOpsError(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canRead]);
  return (
    <OpsPage
      eyebrow="CUSTOMER DELIVERY"
      title="客户交付"
      description="以客户为中心跟进建档、系统接入、功能验收、培训和上线。付款未核验时，受控环节会保持阻断。"
      actions={<Button onClick={() => void load()} loading={loading} disabled={!canRead}>刷新交付档案</Button>}
    >
      {!canRead ? <Alert type="warning" showIcon message="当前会话没有客户交付读取权限" description="请切换到具备 customer.delivery.read 的平台运营工作区。" /> : null}
      {error ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message="客户交付数据加载失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
      <CustomerDeliverySection records={records} />
    </OpsPage>
  );
}
