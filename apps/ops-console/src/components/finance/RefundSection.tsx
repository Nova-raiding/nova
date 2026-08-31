import { Button, Card, Form, Input, Modal, Tag } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

interface RefundSectionProps {
  model: OpsConsoleModel;
}

export function RefundSection({ model }: RefundSectionProps) {
  const { refundForm, refund, canFinance, refundSubmitting } = model;
  const confirmRefund = (values: { orderId: string; reason: string }) => {
    Modal.confirm({
      title: "确认创建退款？",
      content: `订单 ${values.orderId} 将按服务端订单状态和原支付金额执行退款。原因：${values.reason}`,
      okText: "确认退款",
      cancelText: "返回修改",
      okButtonProps: { danger: true },
      onOk: () => refund(values),
    });
  };

  return (
    <Card
      title="退款操作"
      extra={<Tag color="orange">需要 finance 或 merchant_admin 权限</Tag>}
    >
      <Form
        form={refundForm}
        layout="inline"
        onFinish={confirmRefund}
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name;
          if (first) refundForm.scrollToField(first, { block: "center", focus: true });
        }}
        disabled={!canFinance}
        aria-label="创建退款"
      >
        <Form.Item name="orderId" label="充值订单 ID" rules={[{ required: true, message: "请输入已到账的充值订单 ID" }]}>
          <Input placeholder="例如 recharge_..." autoComplete="off" />
        </Form.Item>
        <Form.Item name="reason" label="退款原因" rules={[{ required: true, message: "请输入退款原因" }, { min: 4, message: "退款原因至少 4 个字符" }]}>
          <Input placeholder="填写工单号和退款依据" />
        </Form.Item>
        <Button disabled={!canFinance} loading={refundSubmitting} danger type="primary" htmlType="submit">
          创建退款
        </Button>
      </Form>
    </Card>
  );
}
