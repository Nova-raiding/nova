import { Alert, Button } from "antd";
import { OpsPage } from "../components/OpsPage.js";
import { CustomerDeliverySection } from "../components/delivery/CustomerDeliverySection.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";

export function CustomerDeliveryPage({ model }: { model: OpsConsoleModel }) {
  const canRead = model.authorization.can("customer.delivery.read") || model.authorization.can("workspace.directory.read");
  return (
    <OpsPage
      eyebrow="CUSTOMER DELIVERY"
      title="客户交付"
      description="以客户为中心跟进建档、系统接入、功能验收、培训和上线。付款未核验时，受控环节会保持阻断。"
      actions={<Button onClick={() => void model.load()} loading={model.loading} disabled={!canRead}>刷新交付档案</Button>}
    >
      {!canRead ? <Alert type="warning" showIcon message="当前会话没有客户交付读取权限" description="请切换到具备 customer.delivery.read 的平台运营工作区。" /> : null}
      <CustomerDeliverySection records={[]} />
    </OpsPage>
  );
}
