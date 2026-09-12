import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./src/App.tsx', import.meta.url), 'utf8')
const styleSource = readFileSync(new URL('./src/styles.css', import.meta.url), 'utf8')

describe('merchant overview notification center', () => {
  it('moves the action queue into the top-right notification trigger', () => {
    expect(appSource).toContain("<Bell size={18}")
    expect(appSource).toContain('<Dropdown trigger={[\'click\']} placement="bottomRight"')
    expect(appSource).toContain('fetchWorkspaceMetrics(apiBaseUrl)')
    expect(appSource).toContain('onOpenIssues={() => navigateTo(\'products\', { clearContext: true })}')
    expect(appSource).not.toContain('issue-queue-panel')
  })

  it('supports item detail and an explicit handling action', () => {
    expect(appSource).toContain('问题详情')
    expect(appSource).toContain('查看并处理')
    expect(appSource).toContain('打开商品与任务查看处理方式')
  })

  it('keeps the notification surface keyboard-visible and visually bounded', () => {
    expect(styleSource).toContain('.merchant-notification-panel')
    expect(styleSource).toContain('.merchant-notification-item-button:focus-visible')
    expect(styleSource).toContain('max-height:560px')
  })

  it('renders knowledge cards as read-only information blocks', () => {
    expect(appSource).toContain('<Table')
    expect(appSource).toContain('knowledge-table-wrap')
    expect(appSource).toContain('pageSizeOptions: [10, 20, 50]')
    expect(appSource).toContain('showTotal: (total) => `共 ${total} 项`')
    expect(appSource).not.toContain("title: '下一步'")
    expect(appSource).not.toContain('asset-preference-editor')
    expect(appSource).not.toContain('asset-product-usage-open-')
    expect(appSource).not.toContain('asset-primary-action-')
  })
})
