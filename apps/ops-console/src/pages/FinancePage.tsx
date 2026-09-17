import { Alert, Divider } from "antd";
import { FinanceSearchSection } from "../components/finance/FinanceSearchSection";
import { RechargeOrdersSection } from "../components/finance/RechargeOrdersSection";
import { OpsPage } from "../components/OpsPage";
import { useFinanceSearch } from "../hooks/useFinanceSearch";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface FinancePageProps {
  model: OpsConsoleModel;
}

/** Platform-wide billing is intentionally isolated from merchant workspaces.
 * The server remains the authority for both data access and export rights. */
export function FinancePage({ model }: FinancePageProps) {
  const canReadPlatformFinance = model.authorization.can("billing.platform.read");
  const financeSearch = useFinanceSearch(
    model.financeSearchClient,
    { limit: 50 },
    canReadPlatformFinance,
  );

  return (
    <OpsPage
      eyebrow="PLATFORM FINANCE"
      title="财务与账务"
      description="查看跨企业主体的充值、订阅、用量与成本证据；页面不展示或代替任何第三方平台授权。"
      nextStep="金额、成本和服务商对账状态均以服务端返回的证据为准；缺失证据不会显示为零。"
    >
      {!canReadPlatformFinance ? (
        <Alert type="error" showIcon title="当前会话没有平台财务读取权限" description="请由平台管理员授予 billing.platform.read 后重新登录；浏览器不能自行提升权限。" />
      ) : <>
        <FinanceSearchSection controller={financeSearch} />
        <Divider />
        <RechargeOrdersSection model={model} />
      </>}
    </OpsPage>
  );
}
