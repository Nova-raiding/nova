import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  LinkOutlined,
  ReloadOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { RechargeOrder, RechargeOrderState } from "../../types/ops";
import {
  rechargeOrderCount,
  rechargeOrderPresentation,
  rechargeOrderStates,
  rechargeOrderTotal,
  safePaymentUrl,
} from "./rechargeOrders";

interface RechargeOrdersSectionProps {
  model: OpsConsoleModel;
}

const formatTime = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "—";

export function RechargeOrdersSection({ model }: RechargeOrdersSectionProps) {
  const {
    rechargeOrders,
    rechargeOrdersLoading,
    rechargeOrdersError,
    rechargeOrderStateFilter,
    canPaymentReconciliation,
    loadRechargeOrders,
    queryRechargeOrder,
    queryingRechargeOrderId,
  } = model;
  const orders = rechargeOrders?.orders ?? [];
  const summary = rechargeOrders?.summary;

  const stateOptions = [
    { label: `全部 ${rechargeOrderTotal(summary, orders, rechargeOrders?.total)}`, value: "all" },
    ...rechargeOrderStates.map((state) => ({
      label: `${rechargeOrderPresentation[state].label} ${rechargeOrderCount(state, summary, orders)}`,
      value: state,
    })),
  ];

  return (
    <Card
      id="ops-recharge-orders"
      className="ops-section-anchor"
      title="充值订单状态中心"
      extra={
        <Button
          icon={<ReloadOutlined />}
          loading={rechargeOrdersLoading}
          aria-label="刷新充值订单"
          onClick={() => void loadRechargeOrders(rechargeOrderStateFilter)}
        >
          刷新
        </Button>
      }
    >
      <Row gutter={[16, 16]} className="finance-summary" aria-label="充值订单汇总">
        <Col xs={12} md={6}>
          <Statistic title="订单总数" value={rechargeOrderTotal(summary, orders, rechargeOrders?.total)} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="待支付" value={rechargeOrderCount("pending", summary, orders)} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="已支付" value={rechargeOrderCount("paid", summary, orders)} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="异常"
            value={rechargeOrderCount("failed", summary, orders)}
            styles={rechargeOrderCount("failed", summary, orders) ? { content: { color: "#b91c1c" } } : undefined}
          />
        </Col>
      </Row>

      {rechargeOrdersError && (
        <Alert
          type="error"
          showIcon
          title="充值订单加载失败"
          description={rechargeOrdersError}
          action={
            <Button
              size="small"
              aria-label="重试加载充值订单"
              onClick={() => void loadRechargeOrders(rechargeOrderStateFilter)}
            >
              重试
            </Button>
          }
        />
      )}

      <Space orientation="vertical" size="middle" className="full-width">
        <Segmented
          aria-label="充值订单状态筛选"
          options={stateOptions}
          value={rechargeOrderStateFilter ?? "all"}
          onChange={(value) =>
            void loadRechargeOrders(
              value === "all" ? undefined : (value as RechargeOrderState),
            )
          }
        />
        <Table
          rowKey="id"
          size="small"
          loading={rechargeOrdersLoading}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{ emptyText: "当前筛选条件下没有充值订单" }}
          dataSource={orders}
          scroll={{ x: 1380 }}
          columns={[
            {
              title: "状态",
              dataIndex: "state",
              fixed: "left",
              width: 100,
              render: (state: RechargeOrderState) => {
                const presentation = rechargeOrderPresentation[state];
                return presentation ? <Tag color={presentation.color}>{presentation.label}</Tag> : <Tag>{state}</Tag>;
              },
            },
            {
              title: "订单号",
              dataIndex: "id",
              width: 210,
              render: (value: string) => <Typography.Text className="ops-token" copyable>{value}</Typography.Text>,
            },
            {
              title: "工作区",
              dataIndex: "workspace_id",
              width: 180,
              render: (value: string) => <Typography.Text className="ops-token" copyable>{value}</Typography.Text>,
            },
            { title: "渠道", dataIndex: "channel", width: 100 },
            {
              title: "金额",
              dataIndex: "amount_cny",
              width: 110,
              align: "right",
              render: (value: string) => `¥${Number(value).toFixed(2)}`,
            },
            {
              title: "Provider 交易号",
              dataIndex: "provider_trade_id",
              width: 210,
              render: (value: string | null) =>
                value ? <Typography.Text className="ops-token" copyable>{value}</Typography.Text> : "—",
            },
            { title: "创建时间", dataIndex: "created_at", width: 180, render: formatTime },
            { title: "过期时间", dataIndex: "expires_at", width: 180, render: formatTime },
            { title: "支付时间", dataIndex: "paid_at", width: 180, render: formatTime },
            {
              title: "操作",
              key: "actions",
              fixed: "right",
              width: 190,
              render: (_value, record: RechargeOrder) => {
                const paymentUrl = safePaymentUrl(record.payment_url);
                return (
                  <Space>
                    <Tooltip title={canPaymentReconciliation ? "向支付渠道查询该订单的最新状态" : "当前账号没有支付查单权限"}>
                      <span>
                        <Button
                          size="small"
                          icon={<SyncOutlined />}
                          disabled={!canPaymentReconciliation}
                          loading={queryingRechargeOrderId === record.id}
                          aria-label={`查询充值订单 ${record.id}`}
                          onClick={() => void queryRechargeOrder(record.id)}
                        >
                          查单
                        </Button>
                      </span>
                    </Tooltip>
                    {paymentUrl && record.state === "pending" && (
                      <Button
                        size="small"
                        type="link"
                        icon={<LinkOutlined />}
                        href={paymentUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`打开充值订单 ${record.id} 的支付页面`}
                      >
                        支付页
                      </Button>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      </Space>
    </Card>
  );
}
