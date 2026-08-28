import { Button, InputNumber, Table } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Coupon } from "../../types/ops";

interface CouponTableProps {
  model: OpsConsoleModel;
}

export function CouponTable({ model }: CouponTableProps) {
  const { coupons, setCoupons, canGlobalCommercial, saveCoupon } = model;

  return (
    <Table
      rowKey="code"
      pagination={false}
      dataSource={coupons}
      columns={[
        { title: "编码", dataIndex: "code" },
        { title: "折扣类型", dataIndex: "discountType" },
        {
          title: "折扣值",
          render: (_: unknown, row: Coupon) => (
            <InputNumber
              disabled={!canGlobalCommercial}
              min={0}
              precision={2}
              value={row.discountValue}
              onChange={(value) =>
                setCoupons((current) =>
                  current.map((item) =>
                    item.code === row.code
                      ? {
                          ...item,
                          discountValue: Number(value ?? 0),
                        }
                      : item,
                  ),
                )
              }
            />
          ),
        },
        {
          title: "上限",
          render: (_: unknown, row: Coupon) => (
            <InputNumber
              disabled={!canGlobalCommercial}
              min={0}
              value={row.maxRedemptions}
              onChange={(value) =>
                setCoupons((current) =>
                  current.map((item) =>
                    item.code === row.code
                      ? {
                          ...item,
                          maxRedemptions: Number(value ?? 0),
                        }
                      : item,
                  ),
                )
              }
            />
          ),
        },
        { title: "已用", dataIndex: "redeemedCount" },
        {
          title: "操作",
          render: (_: unknown, row: Coupon) => (
            <Button
              disabled={!canGlobalCommercial}
              type="link"
              onClick={() => void saveCoupon(row)}
            >
              保存
            </Button>
          ),
        },
      ]}
    />
  );
}
