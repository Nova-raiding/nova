import { Button, Card, Input, Select, Space } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { platformLabels, platforms } from "../../types/ops";

interface AlertFiltersSectionProps {
  model: OpsConsoleModel;
}

export async function clearAlertFilters(
  model: Pick<OpsConsoleModel, "setAlertFilters" | "load">,
) {
  model.setAlertFilters({});
  await model.load({ alertFilters: {} });
}

export function AlertFiltersSection({ model }: AlertFiltersSectionProps) {
  const { alertFilters, load, setAlertFilters, storeDirectory } = model;

  return (
    <Card title="平台告警筛选" size="small">
      <Space wrap>
        <Select
          allowClear
          placeholder="平台"
          style={{ width: 150 }}
          value={alertFilters.platform}
          onChange={(value) =>
            setAlertFilters((current) => ({ ...current, platform: value }))
          }
          options={platforms.map((platform) => ({
            value: platform,
            label: platformLabels[platform],
          }))}
        />
        <Select
          allowClear
          placeholder="店铺"
          style={{ width: 240 }}
          value={alertFilters.accountId}
          onChange={(value) =>
            setAlertFilters((current) => ({ ...current, accountId: value }))
          }
          options={storeDirectory.map((store) => ({
            value: store.accountId,
            label: `${store.label} · ${platformLabels[store.platform]}`,
          }))}
        />
        <Input
          allowClear
          placeholder="告警编码"
          style={{ width: 180 }}
          value={alertFilters.code ?? ""}
          onChange={(event) =>
            setAlertFilters((current) => ({
              ...current,
              code: event.target.value || undefined,
            }))
          }
        />
        <Input
          allowClear
          placeholder="对象类型"
          style={{ width: 180 }}
          value={alertFilters.entityType ?? ""}
          onChange={(event) =>
            setAlertFilters((current) => ({
              ...current,
              entityType: event.target.value || undefined,
            }))
          }
        />
        <Input
          allowClear
          placeholder="对象 ID"
          style={{ width: 180 }}
          value={alertFilters.entityId ?? ""}
          onChange={(event) =>
            setAlertFilters((current) => ({
              ...current,
              entityId: event.target.value || undefined,
            }))
          }
        />
        <Button type="primary" onClick={() => void load()}>
          应用告警筛选
        </Button>
        <Button
          onClick={() => void clearAlertFilters(model)}
        >
          清除告警筛选
        </Button>
      </Space>
    </Card>
  );
}
