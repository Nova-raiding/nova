import { Button, Input, InputNumber, Switch, Table } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Addon } from "../../types/ops";

interface AddonTableProps {
  model: OpsConsoleModel;
}

export function AddonTable({ model }: AddonTableProps) {
  const { addons, setAddons, canPlatformOps, saveAddon } = model;

  return (
    <Table
      rowKey="code"
      pagination={false}
      dataSource={addons}
      columns={[
        { title: "编码", dataIndex: "code" },
        {
          title: "名称",
          render: (_: unknown, row: Addon) => (
            <Input
              disabled={!canPlatformOps}
              value={row.name}
              onChange={(event) =>
                setAddons((current) =>
                  current.map((item) =>
                    item.code === row.code
                      ? {
                          ...item,
                          name: event.target.value,
                        }
                      : item,
                  ),
                )
              }
            />
          ),
        },
        { title: "类型", dataIndex: "kind" },
        {
          title: "价格（元）",
          render: (_: unknown, row: Addon) => (
            <InputNumber
              disabled={!canPlatformOps}
              min={0}
              precision={2}
              value={row.priceCny}
              onChange={(value) =>
                setAddons((current) =>
                  current.map((item) =>
                    item.code === row.code
                      ? {
                          ...item,
                          priceCny: Number(value ?? 0),
                        }
                      : item,
                  ),
                )
              }
            />
          ),
        },
        {
          title: "数量",
          render: (_: unknown, row: Addon) => (
            <InputNumber
              disabled={!canPlatformOps}
              min={0}
              value={row.units}
              onChange={(value) =>
                setAddons((current) =>
                  current.map((item) =>
                    item.code === row.code
                      ? {
                          ...item,
                          units: Number(value ?? 0),
                        }
                      : item,
                  ),
                )
              }
            />
          ),
        },
        {
          title: "启用",
          render: (_: unknown, row: Addon) => (
            <Switch
              disabled={!canPlatformOps}
              checked={row.active}
              onChange={(active) =>
                setAddons((current) =>
                  current.map((item) =>
                    item.code === row.code ? { ...item, active } : item,
                  ),
                )
              }
            />
          ),
        },
        {
          title: "操作",
          render: (_: unknown, row: Addon) => (
            <Button
              disabled={!canPlatformOps}
              type="link"
              onClick={() => void saveAddon(row)}
            >
              保存
            </Button>
          ),
        },
      ]}
    />
  );
}
