import { Button, Input, InputNumber, Switch, Table, Typography } from "antd";
import { offerChangeErrors, type OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Offer } from "../../types/ops";

interface OfferTableProps {
  model: OpsConsoleModel;
}

export function offerDateTimeInputValue(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 16);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function offerDateTimeIsoValue(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

export function OfferTable({ model }: OfferTableProps) {
  const { offers, setOffers, canGlobalCommercial, saveOffer } = model;
  const updateOffer = <K extends keyof Offer>(row: Offer, key: K, value: Offer[K]) =>
    setOffers((current) => current.map((item) => item.code === row.code ? { ...item, [key]: value } : item));

  return (
    <Table
      rowKey="code"
      pagination={false}
      dataSource={offers}
      scroll={{ x: 1540 }}
      columns={[
        { title: "编码", dataIndex: "code", width: 130 },
        {
          title: "名称",
          width: 180,
          render: (_: unknown, row: Offer) => <Input disabled={!canGlobalCommercial} value={row.name} onChange={(event) => updateOffer(row, "name", event.target.value)} />,
        },
        { title: "周期", dataIndex: "billingCycle", width: 90 },
        {
          title: "价格（元）",
          width: 120,
          render: (_: unknown, row: Offer) => <InputNumber disabled={!canGlobalCommercial} min={0} precision={2} value={row.priceCny} onChange={(value) => updateOffer(row, "priceCny", Number(value ?? 0))} />,
        },
        {
          title: "店铺",
          width: 90,
          render: (_: unknown, row: Offer) => <InputNumber disabled={!canGlobalCommercial} min={0} value={row.includedStores} onChange={(value) => updateOffer(row, "includedStores", Number(value ?? 0))} />,
        },
        {
          title: "任务/月",
          width: 100,
          render: (_: unknown, row: Offer) => <InputNumber disabled={!canGlobalCommercial} min={0} value={row.includedTasks} onChange={(value) => updateOffer(row, "includedTasks", Number(value ?? 0))} />,
        },
        {
          title: "启用",
          width: 80,
          render: (_: unknown, row: Offer) => <Switch disabled={!canGlobalCommercial} checked={row.active} onChange={(active) => updateOffer(row, "active", active)} />,
        },
        {
          title: "生效时间",
          width: 220,
          render: (_: unknown, row: Offer) => {
            const error = offerChangeErrors(row).validFrom;
            return <div><Input aria-label={`${row.code} 生效时间`} type="datetime-local" disabled={!canGlobalCommercial} status={error ? "error" : undefined} value={offerDateTimeInputValue(row.validFrom)} onChange={(event) => updateOffer(row, "validFrom", offerDateTimeIsoValue(event.target.value) ?? "")} />{error && <Typography.Text type="danger">{error}</Typography.Text>}</div>;
          },
        },
        {
          title: "失效时间（可选）",
          width: 220,
          render: (_: unknown, row: Offer) => {
            const error = offerChangeErrors(row).validTo;
            return <div><Input aria-label={`${row.code} 失效时间`} type="datetime-local" disabled={!canGlobalCommercial} status={error ? "error" : undefined} value={offerDateTimeInputValue(row.validTo)} onChange={(event) => updateOffer(row, "validTo", offerDateTimeIsoValue(event.target.value))} />{error && <Typography.Text type="danger">{error}</Typography.Text>}</div>;
          },
        },
        {
          title: "变更原因",
          width: 240,
          render: (_: unknown, row: Offer) => {
            const error = offerChangeErrors(row).reason;
            return <div><Input aria-label={`${row.code} 变更原因`} disabled={!canGlobalCommercial} maxLength={500} status={error && row.changeReason !== undefined ? "error" : undefined} value={row.changeReason ?? ""} placeholder="必填，写入操作审计" onChange={(event) => updateOffer(row, "changeReason", event.target.value)} />{error && row.changeReason !== undefined && <Typography.Text type="danger">{error}</Typography.Text>}</div>;
          },
        },
        {
          title: "操作",
          fixed: "right",
          width: 100,
          render: (_: unknown, row: Offer) => <Button disabled={!canGlobalCommercial} aria-label={`保存套餐 ${row.code}`} type="link" onClick={() => void saveOffer(row)}>保存</Button>,
        },
      ]}
    />
  );
}
