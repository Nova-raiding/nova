import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LocalPluginCapabilityRetryButton, readLocalPluginCapability } from './LocalPluginConnection'

describe('local plugin capability read recovery', () => {
  it('offers an explicit retry button and invokes only its read callback', async () => {
    const retry = vi.fn()
    const button = LocalPluginCapabilityRetryButton({ visible: true, loading: false, onRetry: retry })
    expect(button).not.toBeNull()
    expect(renderToStaticMarkup(React.createElement(() => button))).toContain('重新检查一键连接')
    await button!.props.onClick()
    expect(retry).toHaveBeenCalledOnce()

    expect(LocalPluginCapabilityRetryButton({ visible: false, loading: false, onRetry: retry })).toBeNull()
  })

  it('rechecks capability with a workspace scoped GET and no enrollment or connection write', async () => {
    const readApi = vi.fn(async () => ({ one_click_available: true, supported_platforms: ['macos'] }))
    await expect(readLocalPluginCapability('/api', 'ws_retry_fixture', readApi as never)).resolves.toBe('available')
    expect(readApi).toHaveBeenCalledOnce()
    expect(readApi).toHaveBeenCalledWith('/api', '/v1/auth/local-plugin/connect-capability', {}, 'ws_retry_fixture')
  })
})
