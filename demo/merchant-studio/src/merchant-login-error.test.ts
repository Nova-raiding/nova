import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MerchantLoginPage } from './MerchantLoginPage'

const render = (error?: string) => renderToStaticMarkup(createElement(MerchantLoginPage, {
  apiBaseUrl: 'http://127.0.0.1:9',
  ...(error === undefined ? {} : { error }),
  onAuthenticated: () => undefined,
  onRetry: () => undefined,
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
})
