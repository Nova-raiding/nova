import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})
describe('an unconfigured application is never an authenticated workspace',()=>{
 it.each(['', '   '])('provides configuration recovery for an empty base (%j) without constructing a session', baseUrl=>{
  vi.stubEnv('VITE_API_BASE_URL',baseUrl)
  const html=renderToStaticMarkup(createElement(App))
  expect(html).toContain('工作区服务尚未连接')
  expect(html).toContain('重新检查连接')
  expect(html).not.toContain('打开账号菜单')
  expect(html).not.toContain('运营概览')
  expect(html).not.toContain('测试账号')
  expect(html).not.toContain('登录商家工作台')
 })
})
