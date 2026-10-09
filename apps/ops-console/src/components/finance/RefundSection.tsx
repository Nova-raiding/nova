import { Alert, Button, Card, Form, Input, Tag } from "antd";
import { useEffect, useState } from "react";
import { readPaymentRuntimeReadiness, type PaymentRuntimeReadiness } from "../../api/opsClient.js";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";

interface RefundSectionProps {
  model: OpsConsoleModel;
}

export function RefundSection({ model }: RefundSectionProps) {
  const { refundForm, refund, canFinance, refundSubmitting } = model;
  const [paymentReadiness, setPaymentReadiness] = useState<PaymentRuntimeReadiness>({ mode: "unknown", ready: false, reasons: [] });
  useEffect(() => {
    if (model.authorization.scope.kind !== "platform") return;
    let active = true;
    void readPaymentRuntimeReadiness().then(readiness => { if (active) setPaymentReadiness(readiness); });
    return () => { active = false; };
  }, [model.authorization.scope.kind]);
  // The current MCP billing.refund contract is platform-operations scoped.
  // Workspace capability projections can contain billing.refund.execute, but
  // the API deliberately rejects workspace finance identities. Do not present
  // an enabled form that can only end in a 403.
  if (model.authorization.scope.kind !== "platform") {
    return (
      <Card title="退款操作" extra={<Tag color="default">工作区身份不可执行</Tag>}>
        <Alert
          type="info"
          showIcon
          title="当前工作区暂不开放充值订单退款"
          description="服务端 billing.refund 接口目前仅接受平台管理员、运营管理员、平台运营或财务运营角色；本工作区页面不会提交退款请求。请联系平台财务运营处理。"
        />
      </Card>
    );
  }
  const providerRefundAvailable = paymentReadiness.mode === "provider" && paymentReadiness.ready;
  // 确认只在 `refund()` 内部弹一次，程序化调用者同样受保护。此处不能再弹第二层：
  // 表单 onOk 返回 promise 时 antd 会让第一层带着 loading 停在第二层下方，取消第二层
  // 只会让两层静默消失，操作者无法判断退款是否已发生。
  const submitRefund = (values: { orderId: string; reason: string }) => {
    // Match the server's required() contract and keep audit/provider reasons
    // canonical even when operators accidentally pad either field.
    void refund({ orderId: values.orderId.trim(), reason: values.reason.trim() });
  };

  return (
    <Card
      title="退款操作"
      extra={<Tag color="orange">仅限平台管理员、运营管理员、平台运营或财务运营角色</Tag>}
    >
      {paymentReadiness.mode === "manual_transfer" ? <Alert
        style={{ marginBottom: 16 }}
        type="warning"
        showIcon
        title="当前为人工转账收款，不支持自动退款"
        description="当前运行环境为 lean/manual_transfer，服务端已禁用支付服务商退款。请联系平台财务运营人工处理；本页不会提交退款请求。"
      /> : null}
      {paymentReadiness.mode === "fixture" ? <Alert
        style={{ marginBottom: 16 }}
        type="info"
        showIcon
        title="演示支付模式不支持真实退款"
        description="当前运行环境未确认使用真实支付服务商，退款表单已禁用。"
      /> : null}
      {paymentReadiness.mode === "provider" && !paymentReadiness.ready ? <Alert
        style={{ marginBottom: 16 }}
        type="warning"
        showIcon
        title="支付服务商已配置但尚未就绪，退款已阻断"
        description={paymentReadiness.reasons.length
          ? `运行时未确认支付能力已生效：${paymentReadiness.reasons.join("、")}`
          : "运行时未同时确认 provider 已配置、支付能力已生效且状态为 enabled；退款保持禁用。"}
      /> : null}
      {paymentReadiness.mode === "unknown" ? <Alert
        style={{ marginBottom: 16 }}
        type="info"
        showIcon
        title="尚未确认支付模式"
        description="无法从 API 健康状态确认当前支付模式，退款表单保持禁用。请刷新页面或联系平台财务运营。"
      /> : null}
      <Form
        form={refundForm}
        layout="inline"
        onFinish={submitRefund}
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name;
          if (first) refundForm.scrollToField(first, { block: "center", focus: true });
        }}
        disabled={!canFinance || !providerRefundAvailable}
        aria-label="创建退款"
      >
        <Form.Item name="orderId" label="充值订单 ID" rules={[{ required: true, whitespace: true, message: "请输入已到账的充值订单 ID" }]}>
          <Input placeholder="例如 recharge_..." autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="reason"
          label="退款原因"
          rules={[
            {
              validator: async (_rule, value: unknown) => {
                const reason = typeof value === "string" ? value.trim() : "";
                if (!reason) throw new Error("请输入退款原因");
              },
            },
          ]}
        >
          <Input placeholder="填写工单号和退款依据" />
        </Form.Item>
        <Button disabled={!canFinance || !providerRefundAvailable} loading={refundSubmitting} danger type="primary" htmlType="submit">
          创建退款
        </Button>
      </Form>
    </Card>
  );
}
