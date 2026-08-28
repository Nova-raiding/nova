import { Button, InputNumber, Switch, Table } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Rollout } from "../../types/ops";

interface RolloutTableProps {
  model: OpsConsoleModel;
}

export function RolloutTable({ model }: RolloutTableProps) {
  const { rollouts, setRollouts, canPlatformOps, saveRollout } = model;

  return (
    <Table
      rowKey="id"
      pagination={false}
      dataSource={rollouts}
      columns={[
        { title: "套餐", dataIndex: "offerCode" },
        {
          title: "工作区",
          dataIndex: "workspaceId",
          render: (value: string | undefined) => value || "全局",
        },
        {
          title: "比例（%）",
          render: (_: unknown, row: Rollout) => (
            <InputNumber
              disabled={!canPlatformOps}
              min={0}
              max={100}
              value={row.percentage}
              onChange={(value) =>
                setRollouts((current) =>
                  current.map((item) =>
                    item.id === row.id
                      ? {
                          ...item,
                          percentage: Number(value ?? 0),
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
          render: (_: unknown, row: Rollout) => (
            <Switch
              disabled={!canPlatformOps}
              checked={row.enabled}
              onChange={(enabled) =>
                setRollouts((current) =>
                  current.map((item) =>
                    item.id === row.id ? { ...item, enabled } : item,
                  ),
                )
              }
            />
          ),
        },
        {
          title: "操作",
          render: (_: unknown, row: Rollout) => (
            <Button
              disabled={!canPlatformOps}
              type="link"
              onClick={() => void saveRollout(row)}
            >
              保存
            </Button>
          ),
        },
      ]}
    />
  );
}
