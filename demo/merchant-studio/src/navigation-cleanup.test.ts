import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar } from './App.js'

const app = readFileSync(resolve(import.meta.dirname, 'App.tsx'), 'utf8')
const css = readFileSync(resolve(import.meta.dirname, 'styles.css'), 'utf8')

describe('merchant navigation cleanup contract', () => {
  it('keeps only knowledge as a new-session entry', () => {
    expect(app).toContain('aria-label="新会话入口"')
    expect(app).toContain("id: 'knowledge'")
    expect(app).not.toContain("id: 'images',")
    expect(app).not.toContain("id: 'assets',")
  })

  it('shows the image alias as a knowledge page without falsely selecting the materials subitem', () => {
    const markup = renderToStaticMarkup(createElement(Sidebar, {
      page: 'products', activeEntry: 'images', setPage: () => {}, open: false, close: () => {}, returnFocus: null,
      backgroundInert: false, onOpenUtility: () => {}, onOpenEntry: () => {},
    }))
    const activeSubItems = [...markup.matchAll(/<button class="active"[^>]*>([\s\S]*?)<\/button>/gu)].map((match) => match[1])
    expect(activeSubItems.some((item) => item?.includes('素材库'))).toBe(false)
  })

  it('keeps member governance out of the screenshot-matched primary rail while retaining its gated route', () => {
    const markup = renderToStaticMarkup(createElement(Sidebar, {
      page: 'overview', setPage: () => {}, open: false, close: () => {}, returnFocus: null,
      backgroundInert: false, onOpenUtility: () => {}, onOpenEntry: () => {},
    }))
    expect(markup).toContain('<nav aria-label="主导航">')
    expect(markup).not.toContain('<span>成员与权限</span>')
    expect(markup).toContain('<span>联系客服经理</span>')
    // Direct entry remains available to existing authorized links; rendering
    // still depends on the same server-derived capability gate.
    expect(app).toContain("page === 'members' && authAccount && <MerchantMembersPage")
  })

  it('keeps the platform-and-store empty-state copy aligned with the reviewed screenshot', () => {
    expect(app).toContain('请点击左侧平台，选择店铺后进入商品页。')
    expect(app).not.toContain('选择一个平台后查看当前工作区登记的店铺。')
  })

  it('describes the recycle bin as browser-local and makes no server restore/delete promise', () => {
    expect(app).toContain("description: '查看本浏览器中已从素材列表隐藏的记录'")
    expect(app).not.toContain('恢复或彻底删除近 7 天内移除的素材')
  })

  it('does not ship the removed welcome panel or duplicate entry cards', () => {
    expect(app).not.toContain('function EntryPointCards')
    expect(css).not.toContain('.welcome-panel')
    expect(css).not.toContain('.flow-preview')
  })

  it('does not expose removed support and diagnostics labels', () => {
    expect(app).not.toContain('帮助与诊断')
    expect(app).not.toContain('客服回复')
  })
})
