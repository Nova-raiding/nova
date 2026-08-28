import { Button, Card, Form, Input, Tag } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

interface RefundSectionProps {
  model: OpsConsoleModel;
}

export function RefundSection({ model }: RefundSectionProps) {
  const { refundForm, refund, canFinance } = model;

  return (
    <Card
      title="退款操作"
      extra={<Tag color="orange">需要 finance 或 merchant_admin 权限</Tag>}
    >
      <Form
        form={refundForm}
        layout="inline"
        onFinish={refund}
        disabled={!canFinance}
      >
        <Form.Item name="orderId" rules={[{ required: true }]}>
          <Input placeholder="已到账充值订单 ID" />
        </Form.Item>
        <Form.Item name="reason" rules={[{ required: true }]}>
          <Input placeholder="退款原因" />
        </Form.Item>
        <Button disabled={!canFinance} danger type="primary" htmlType="submit">
          创建退款
        </Button>
      </Form>
    </Card>
  );
}
