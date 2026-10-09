import { Alert, Card } from "antd";
import { OpsPage } from "../components/OpsPage";
import { ModelStatusSection } from "../components/models/ModelStatusSection";
import { PlatformOverviewSnapshot } from "../components/sections/overview/PlatformOverviewSnapshot";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../navigation/opsNavigation";

interface OverviewPageProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
  onNavigateWithQuery?: (domain: OpsDomain, query: Record<string, string | undefined>) => void;
}

export function OverviewPage({ model, onNavigate, onNavigateWithQuery }: OverviewPageProps) {
  return (
    <OpsPage
      title="运营总览"
      hideTitle
    >
      <div className="ops-overview-page">
        <PlatformOverviewSnapshot model={model} onNavigate={onNavigate} />
        {model.authorization.can("model.status.read") ? (
          <ModelStatusSection model={model} />
        ) : (
          <Card title="模型服务诊断">
            <Alert
              type="info"
              showIcon
              title="当前账号没有模型状态读取权限"
              description="平台中转、五模态运行状态和成本门禁未读取；无权限状态不能解释为模型已配置或已阻断。"
            />
          </Card>
        )}
      </div>
    </OpsPage>
  );
}
