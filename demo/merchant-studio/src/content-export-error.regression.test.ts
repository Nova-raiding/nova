import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMerchantWorkspaceScope, configureMerchantWorkspaceScope, describeContentExportError, downloadContentExport } from './api.js'

describe('content export HTTP error projection', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    configureMerchantWorkspaceScope(['ws_export'], 'ws_export')
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('keeps safe server message, code, and recovery steps while dropping private fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      request_id: 'private-request-id',
      trace_id: 'private-trace-id',
      workspace_id: 'ws_export',
      data: null,
      warnings: [],
      next_actions: ['促销信息已过期，请更新有效期并重新审核', 'content.review 调用参数不应显示'],
      error: {
        code: 'CONTENT_EXPORT_BLOCKED',
        message: '导出被阻止：促销已过期，参考 task_private-record-9382。',
        details: { access_token: 'must-not-leak', workspace_id: 'ws_secret', database: 'internal-db' },
      },
    }), { status: 409, headers: { 'content-type': 'application/json' } })))

    let thrown: unknown
    try {
      await downloadContentExport('/api', 'cv_export', 'bundle')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      code: 'CONTENT_EXPORT_BLOCKED',
      status: 409,
      nextActions: ['促销信息已过期，请更新有效期并重新审核'],
    })
    const visible = describeContentExportError(thrown)
    expect(visible).toContain('促销已过期')
    expect(visible).toContain('下一步：促销信息已过期，请更新有效期并重新审核')
    expect(visible).not.toMatch(/private|must-not-leak|ws_secret|internal-db|content\.review|task_private/iu)
    expect((thrown as Error & { details?: unknown }).details).toBeUndefined()
  })
})
