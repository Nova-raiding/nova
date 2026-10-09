import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar } from './App.js'
import { merchantRouteFromLocation, urlForMerchantRoute } from './navigation.js'

const app = readFileSync(resolve(import.meta.dirname, 'App.tsx'), 'utf8')
const css = readFileSync(resolve(import.meta.dirname, 'styles.css'), 'utf8')

describe('merchant navigation cleanup contract', () => {
  it('restores the task workspace and image-job discovery from a direct tasks URL', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks', search: '', hash: '' })).toEqual({ page: 'task', searchQuery: '' })
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks', search: '?image_job=img_123', hash: '' })).toEqual({ page: 'task', searchQuery: '', imageJobId: 'img_123' })
  })

  it('keeps only knowledge as a new-session entry', () => {
    expect(app).toContain('aria-label="新会话入口"')
    expect(app).toContain("id: 'knowledge'")
    expect(app).not.toContain("id: 'images',")
    expect(app).not.toContain("id: 'assets',")
  })

  it('matches the screenshot-specific selection state for knowledge and image routes', () => {
    for (const [section, materialSubitemActive] of [['knowledge', true], ['images', false]] as const) {
      const route = merchantRouteFromLocation({ pathname: '/merchant/products', search: `?section=${section}`, hash: '' })
      expect(route.page).toBe('products')
      expect(route.entry).toBe(section)

      const markup = renderToStaticMarkup(createElement(Sidebar, {
        page: route.page, activeEntry: route.entry, setPage: () => {}, open: false, close: () => {}, returnFocus: null,
        backgroundInert: false, onOpenUtility: () => {}, onOpenEntry: () => {},
      }))
      const activeSubItems = [...markup.matchAll(/<button class="active"[^>]*>([\s\S]*?)<\/button>/gu)].map((match) => match[1])
      expect(activeSubItems.filter((item) => item?.includes('素材库'))).toHaveLength(materialSubitemActive ? 1 : 0)
    }
    // The catalog route has its own title; image deep-links retain the knowledge title.
    expect(app).toContain("products: activeEntry === 'products' ? '平台&店铺&商品' : activeEntry === 'assets' ? '品牌资产' : activeEntry === 'trash' ? '回收站' : activeEntry === 'images' ? '知识库' : '素材库'")
  })

  it('opens transaction-dashboard issues in the platform and product catalog route', () => {
    expect(app).toContain("onOpenIssues={() => goProducts('products')}")
    const href = urlForMerchantRoute({ pathname: '/merchant/overview', search: '' }, { page: 'products', entry: 'products' })
    expect(href).toBe('/merchant/products?section=products')
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: '?section=products', hash: '' }).entry).toBe('products')
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

  it('describes the recycle bin as workspace-scoped server data', () => {
    expect(app).toContain("description: '查看当前工作区服务端回收的素材'")
    expect(app).not.toContain('本浏览器中已从素材列表隐藏的记录')
    expect(app).toContain('显示当前工作区由服务端记录的已移除素材，保留期限按服务端策略处理。')
  })

  it('does not ship the removed welcome panel or duplicate entry cards', () => {
    expect(app).not.toContain('function EntryPointCards')
    expect(css).not.toContain('.welcome-panel')
    expect(css).not.toContain('.flow-preview')
  })

  it('does not expose removed support and diagnostics labels', () => {
    const markup = renderToStaticMarkup(createElement(Sidebar, {
      page: 'overview', setPage: () => {}, open: false, close: () => {}, returnFocus: null,
      backgroundInert: false, onOpenUtility: () => {}, onOpenEntry: () => {},
    }))
    expect(markup).not.toContain('帮助与诊断')
    expect(markup).not.toContain('客服回复')
  })
})
