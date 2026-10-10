import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MerchantLoginPage } from './MerchantLoginPage'

const render = (error?: string, onRetry?: () => void) => renderToStaticMarkup(createElement(MerchantLoginPage, {
  apiBaseUrl: 'http://127.0.0.1:9',
  ...(error === undefined ? {} : { error }),
  onAuthenticated: () => undefined,
  ...(onRetry ? { onRetry } : {}),
}))

describe('merchant login page shows why the session ended', () => {
  // Regression: the page destructured the parent's `error` as `_error` and never
  // rendered it, and App renders nothing but this page while the session is not
  // authenticated. All three parent notifications were therefore invisible: a
  // merchant who had just changed their password landed on a blank form with no
  // explanation, and an expired session looked like a fresh visit.
  it('renders the parent notification the page used to swallow', () => {
    for (const message of [
      '密码已修改，请使用新密码重新登录。',
      '登录已失效，请重新登录商家工作台。',
      '当前账号不是商家账号，请使用商家账号登录。',
    ]) {
      const html = render(message)
      expect(html, message).toContain(message)
      expect(html, message).toContain('登录未完成')
    }
  })

  it('stays silent when the parent has nothing to report', () => {
    const html = render(undefined)
    expect(html).not.toContain('登录未完成')
    expect(html).toContain('登录商家工作台')
  })

  it('explains the controlled registration and password recovery path', () => {
    const html = render(undefined)
    expect(html).toContain('未登录或会话已失效')
    expect(html).toContain('此入口不支持自助注册')
    expect(html).toContain('忘记密码或工作区绑定有误')
    expect(html).toContain('请联系平台运营核对')
  })

  it('renders the retry action only when session recovery is available', () => {
    expect(render('无法验证登录状态：API 请求超时', () => undefined)).toContain('重新检查登录状态')
    expect(render('无法验证登录状态：API 请求超时')).not.toContain('重新检查登录状态')
  })
})
