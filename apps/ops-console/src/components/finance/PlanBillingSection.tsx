import { Card, Tabs, Tag } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { AddonTable } from "./AddonTable";
import { CouponTable } from "./CouponTable";
import { ModelMarkupPanel } from "./ModelMarkupPanel";
import { OfferTable } from "./OfferTable";
import { RolloutTable } from "./RolloutTable";

interface PlanBillingSectionProps {
  model: OpsConsoleModel;
}

export function PlanBillingSection({ model }: PlanBillingSectionProps) {
  return (
    <Card title="套餐、加购与增长规则" extra={<Tag color="blue">运营目录</Tag>}>
      <Tabs
        items={[
          ...(model.canModelMarkup
            ? [
                {
                  key: "model-markup",
                  label: "模型计费",
                  children: <ModelMarkupPanel model={model} />,
                },
              ]
            : []),
          {
            key: "offers",
            label: "套餐目录",
            children: <OfferTable model={model} />,
          },
          {
            key: "addons",
            label: "加购能力",
            children: <AddonTable model={model} />,
          },
          {
            key: "coupons",
            label: "优惠券",
            children: <CouponTable model={model} />,
          },
          {
            key: "rollouts",
            label: "灰度规则",
            children: <RolloutTable model={model} />,
          },
        ]}
      />
    </Card>
  );
}
