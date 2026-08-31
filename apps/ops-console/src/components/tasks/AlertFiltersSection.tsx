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
          aria-label="按告警平台筛选"
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
          aria-label="按告警店铺筛选"
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
          aria-label="按告警编码筛选"
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
          aria-label="按告警对象类型筛选"
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
          aria-label="按告警对象 ID 筛选"
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
