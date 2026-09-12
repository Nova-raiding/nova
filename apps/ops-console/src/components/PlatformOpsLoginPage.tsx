import { useState } from "react";
import { Alert, Button, Card, Form, Input, Tag, Typography } from "antd";
import { describeOpsError, loginPlatformOps } from "../api/opsClient.js";

type PlatformOpsLoginPageProps = {
  managedSession: boolean;
  error?: string;
  onAuthenticated: () => void;
  onRetry: () => void;
  loading?: boolean;
};

export function PlatformOpsLoginPage({
  managedSession: _managedSession,
  error,
  onAuthenticated,
  onRetry,
  loading = false,
}: PlatformOpsLoginPageProps) {
  const [form] = Form.useForm<{ login: string; password: string }>();
  const [loginError, setLoginError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (values: { login: string; password: string }) => {
    setSubmitting(true);
    setLoginError("");
    try {
      await loginPlatformOps(values);
      form.resetFields();
      onAuthenticated();
    } catch (cause) {
      setLoginError(describeOpsError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="ops-login-page" aria-labelledby="ops-login-title">
      <section className="ops-login-brand-panel" aria-label="平台运营后台说明">
        <div className="ops-login-brand">
          <span className="ops-login-brand-mark" aria-hidden="true">大麦</span>
          <div>
            <Typography.Text className="ops-login-brand-name">大麦运营中心</Typography.Text>
            <Typography.Text className="ops-login-brand-caption">平台运营后台</Typography.Text>
          </div>
        </div>
        <div className="ops-login-brand-copy">
          <Typography.Text className="ops-login-kicker">PLATFORM OPERATIONS</Typography.Text>
          <Typography.Title level={1}>登录平台运营后台</Typography.Title>
          <Typography.Paragraph>
            管理平台规则、商家账号、授权范围、创意点账务和模型服务。登录后只显示当前账号被授权的运营能力。
          </Typography.Paragraph>
        </div>
        <div className="ops-login-trust-list" aria-label="平台后台能力">
          <div><span aria-hidden="true">✓</span><span>平台级用户与角色管理</span></div>
          <div><span aria-hidden="true">✓</span><span>商家工作区和授权审计</span></div>
          <div><span aria-hidden="true">✓</span><span>创意点、模型用量和运营规则</span></div>
        </div>
      </section>

      <section className="ops-login-form-panel">
        <Card className="ops-login-card" variant="borderless">
          <div className="ops-login-card-heading">
            <Typography.Text className="ops-login-eyebrow">安全登录</Typography.Text>
            <Typography.Title id="ops-login-title" level={2}>欢迎回来</Typography.Title>
            <Typography.Paragraph type="secondary">
              使用平台管理员分配的运营账号登录。商家账号不能登录平台运营后台。
            </Typography.Paragraph>
          </div>

          {error ? (
            <Alert
              className="ops-login-alert"
              type="warning"
              showIcon
              title="当前尚未登录"
              description={error}
              action={<Button type="link" size="small" onClick={onRetry}>重试</Button>}
            />
          ) : null}
          {loginError ? (
            <Alert
              className="ops-login-alert"
              type="error"
              showIcon
              role="alert"
              title="登录失败"
              description={loginError}
            />
          ) : null}

          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => void submit(values)}
            disabled={submitting || loading}
            className="ops-login-form"
          >
            <Form.Item
              label="平台运营账号"
              name="login"
              rules={[{ required: true, message: "请输入平台运营账号" }]}
            >
              <Input
                id="ops-login-account"
                size="large"
                autoFocus
                autoComplete="username"
                placeholder="例如 ops@example.com"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                id="ops-login-password"
                size="large"
                autoComplete="current-password"
                placeholder="请输入平台运营密码"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting || loading}>
              登录平台运营后台
            </Button>
            <Typography.Text type="secondary" className="ops-login-helper">
              登录成功后由服务端创建 HttpOnly 会话。密码不会保存到浏览器。
            </Typography.Text>
          </Form>

          <div className="ops-login-footer">
            <Tag color="blue">平台账号</Tag>
            <Typography.Text type="secondary">仅限桌面运营工作台</Typography.Text>
          </div>
        </Card>
      </section>
    </main>
  );
}
