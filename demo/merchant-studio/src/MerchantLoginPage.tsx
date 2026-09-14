import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Typography } from 'antd'
import { LockKeyhole } from 'lucide-react'
import {
  describeApiError,
  loginMerchantAccount,
  type MerchantAuthAccount,
} from './api'

type MerchantLoginPageProps = {
  apiBaseUrl: string
  error?: string
  loading?: boolean
  onAuthenticated: (account: MerchantAuthAccount) => void
  onRetry: () => void
}

export function MerchantLoginPage({
  apiBaseUrl,
  error: _error,
  loading = false,
  onAuthenticated,
  onRetry: _onRetry,
}: MerchantLoginPageProps) {
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const submit = async (values: { login: string; password: string }) => {
    setSubmitting(true)
    setFormError('')
    try {
      onAuthenticated(await loginMerchantAccount(apiBaseUrl, values))
    } catch (cause) {
      setFormError(describeApiError(cause))
    } finally {
      setSubmitting(false)
    }
  }

  // Authentication errors are shown only after the user submits the form.
  // The initial session probe may report an unauthenticated state, which is
  // expected on this page and must not look like a failed login.
  const visibleError = formError
  return (
    <main className="merchant-login-page" aria-labelledby="merchant-login-title">
      <section className="merchant-login-form-panel">
        <Card className="merchant-login-card" variant="borderless">
          <div className="merchant-login-card-heading">
            <Typography.Text className="merchant-login-eyebrow">安全登录</Typography.Text>
            <Typography.Title id="merchant-login-title" level={2}>欢迎回来</Typography.Title>
            <Typography.Paragraph type="secondary">
              使用平台管理员分配的商家账号登录。平台运营账号不能登录商家工作台。
            </Typography.Paragraph>
          </div>
          {visibleError ? (
            <Alert
              className="merchant-login-alert"
              type="error"
              showIcon
              title="登录未完成"
              description={visibleError}
            />
          ) : null}
          <Form
            className="merchant-login-form"
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => void submit(values)}
            aria-label="商家账号登录"
          >
            <Form.Item
              label="商家账号"
              name="login"
              rules={[{ required: true, whitespace: true, message: '请输入商家账号' }]}
            >
              <Input
                id="merchant-login-account"
                size="large"
                autoFocus
                autoComplete="username"
                placeholder="例如 merchant@example.com"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入商家密码' }]}
            >
              <Input.Password
                id="merchant-login-password"
                size="large"
                autoComplete="current-password"
                placeholder="请输入商家密码"
                prefix={<LockKeyhole size={16} aria-hidden="true" />}
              />
            </Form.Item>
            <Button
              className="merchant-login-submit"
              type="primary"
              htmlType="submit"
              size="large"
              loading={submitting || loading}
              block
            >
              登录商家工作台
            </Button>
          </Form>
          <Typography.Text type="secondary" className="merchant-login-helper">
            没有账号？请联系平台运营创建商家账号并分配企业工作区。
          </Typography.Text>
          <div className="merchant-login-footer">
            <span>商家账号</span>
            <span>·</span>
            <span>仅访问已授权租户</span>
          </div>
        </Card>
      </section>
    </main>
  )
}
