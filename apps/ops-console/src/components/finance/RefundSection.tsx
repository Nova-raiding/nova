import { Button, Card, Form, Input, Tag } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

interface RefundSectionProps {
  model: OpsConsoleModel;
}

export function RefundSection({ model }: RefundSectionProps) {
  const { refundForm, refund, canFinance, refundSubmitting } = model;
  // 确认只在 `refund()` 内部弹一次，程序化调用者同样受保护。此处不能再弹第二层：
  // 表单 onOk 返回 promise 时 antd 会让第一层带着 loading 停在第二层下方，取消第二层
  // 只会让两层静默消失，操作者无法判断退款是否已发生。
  const submitRefund = (values: { orderId: string; reason: string }) => {
    void refund(values);
  };

  return (
    <Card
      title="退款操作"
      extra={<Tag color="orange">需要 finance 或 merchant_admin 权限</Tag>}
    >
      <Form
        form={refundForm}
        layout="inline"
        onFinish={submitRefund}
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
