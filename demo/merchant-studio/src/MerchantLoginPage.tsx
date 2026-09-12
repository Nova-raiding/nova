import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Modal, Typography } from 'antd'
import { LockKeyhole } from 'lucide-react'
import {
  describeApiError,
  loginMerchantAccount,
  registerMerchantAccount,
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
  const [registerOpen, setRegisterOpen] = useState(false)
  const [registerResult, setRegisterResult] = useState('')
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
            没有账号？<Button type="link" size="small" onClick={() => { setRegisterResult(''); setRegisterOpen(true) }}>提交注册申请</Button>
          </Typography.Text>
          <div className="merchant-login-footer">
            <span>商家账号</span>
            <span>·</span>
            <span>仅访问已授权租户</span>
          </div>
        </Card>
      </section>
      <Modal title="提交商家注册申请" open={registerOpen} okText="提交申请" cancelText="取消" onCancel={() => setRegisterOpen(false)} footer={registerResult ? <Button type="primary" onClick={() => setRegisterOpen(false)}>完成</Button> : <Button type="primary" onClick={() => (document.getElementById("merchant-registration-form") as HTMLFormElement | null)?.requestSubmit()}>提交申请</Button>}>
        {registerResult ? <Alert showIcon type="success" title="申请已提交" description={registerResult} /> : <Form id="merchant-registration-form" layout="vertical" onFinish={async (values) => { try { const result = await registerMerchantAccount(apiBaseUrl, values); setRegisterResult(`申请编号：${result.applicationId}。当前状态为待平台审核，审核通过后才可以登录。`) } catch (cause) { setFormError(describeApiError(cause)) } }}>
          <Form.Item label="登录邮箱" name="login" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}><Input autoComplete="email" /></Form.Item>
          <Form.Item label="企业名称" name="enterpriseName" rules={[{ required: true, message: '请输入企业名称' }]}><Input /></Form.Item>
          <Form.Item label="联系人" name="contactName" rules={[{ required: true, message: '请输入联系人' }]}><Input /></Form.Item>
          <Form.Item label="登录密码" name="password" rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}><Input.Password autoComplete="new-password" /></Form.Item>
        </Form>}
      </Modal>
    </main>
  )
}
