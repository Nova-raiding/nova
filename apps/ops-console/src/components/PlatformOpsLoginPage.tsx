import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { describeOpsError, loginPlatformOps } from "../api/opsClient.js";
import { storeNovaLogoUrl } from "../assets.js";

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
  const loginErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loginError) loginErrorRef.current?.focus({ preventScroll: true });
  }, [loginError]);

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
      <section className="ops-login-form-panel">
        <Card className="ops-login-card" variant="borderless">
          <div className="ops-login-card-heading">
            <Typography.Title id="ops-login-title" level={1}>欢迎回来</Typography.Title>
            <Typography.Paragraph type="secondary">
              请使用平台管理员分配的运营账号登录
            </Typography.Paragraph>
          </div>

          {error ? (
            <Alert
              className="ops-login-alert"
              type="warning"
              showIcon
              role="status"
              title="当前尚未登录"
              description={error}
              action={<Button type="link" size="small" onClick={onRetry}>重试</Button>}
            />
          ) : null}
          {loginError ? (
            <div
              ref={loginErrorRef}
              className="ops-login-error-summary"
              tabIndex={-1}
              role="group"
              aria-labelledby="ops-login-error-title"
              aria-describedby="ops-login-error-description"
              data-focus-target="login-error"
            >
              <Alert
                className="ops-login-alert"
                type="error"
                showIcon
                role="alert"
                title={<span id="ops-login-error-title">登录失败</span>}
                description={<span id="ops-login-error-description">{loginError}</span>}
              />
            </div>
          ) : null}

          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => void submit(values)}
            scrollToFirstError={{ block: "center", focus: true }}
            disabled={submitting || loading}
            className="ops-login-form"
          >
            <Form.Item
              label="平台运营账号"
              htmlFor="ops-login-account"
              name="login"
              rules={[{ required: true, message: "请输入平台运营账号" }]}
            >
              <Input
                id="ops-login-account"
                aria-label="平台运营账号"
                size="large"
                autoFocus
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              htmlFor="ops-login-password"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                id="ops-login-password"
                aria-label="密码"
                size="large"
                autoComplete="current-password"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting || loading}>
              登录平台运营后台
            </Button>
          </Form>

          <div className="ops-login-footer" aria-label="Store Nova">
            <img src={storeNovaLogoUrl} alt="Store Nova" />
          </div>
        </Card>
      </section>
    </main>
  );
}
