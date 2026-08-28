import { Button, Input, InputNumber, Switch, Table } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Offer } from "../../types/ops";

interface OfferTableProps {
  model: OpsConsoleModel;
}

export function OfferTable({ model }: OfferTableProps) {
  const { offers, setOffers, canGlobalCommercial, saveOffer } = model;

  return (
    <Table
      rowKey="code"
      pagination={false}
      dataSource={offers}
      columns={[
        { title: "编码", dataIndex: "code" },
        {
          title: "名称",
          render: (_: unknown, row: Offer) => (
            <Input
              disabled={!canGlobalCommercial}
              value={row.name}
              onChange={(event) =>
                setOffers((current) =>
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
        { title: "周期", dataIndex: "billingCycle" },
        {
          title: "价格（元）",
          render: (_: unknown, row: Offer) => (
            <InputNumber
              disabled={!canGlobalCommercial}
              min={0}
              precision={2}
              value={row.priceCny}
              onChange={(value) =>
                setOffers((current) =>
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
          title: "店铺",
          render: (_: unknown, row: Offer) => (
            <InputNumber
              disabled={!canGlobalCommercial}
              min={0}
              value={row.includedStores}
              onChange={(value) =>
                setOffers((current) =>
                  current.map((item) =>
                    item.code === row.code
                      ? {
                          ...item,
                          includedStores: Number(value ?? 0),
                        }
                      : item,
                  ),
                )
              }
            />
          ),
        },
        {
          title: "任务/月",
          render: (_: unknown, row: Offer) => (
            <InputNumber
              disabled={!canGlobalCommercial}
              min={0}
              value={row.includedTasks}
              onChange={(value) =>
                setOffers((current) =>
                  current.map((item) =>
                    item.code === row.code
                      ? {
                          ...item,
                          includedTasks: Number(value ?? 0),
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
          render: (_: unknown, row: Offer) => (
            <Switch
              disabled={!canGlobalCommercial}
              checked={row.active}
              onChange={(active) =>
                setOffers((current) =>
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
          render: (_: unknown, row: Offer) => (
            <Button
              disabled={!canGlobalCommercial}
              type="link"
              onClick={() => void saveOffer(row)}
            >
              保存
            </Button>
          ),
        },
      ]}
    />
  );
}
