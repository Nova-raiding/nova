import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeliveryReadinessPanel } from './DeliveryReadinessPanel'

describe('delivery evidence without a configured service', () => {
  it('announces unavailable evidence instead of a successfully read zero count', () => {
    const html = renderToStaticMarkup(createElement(DeliveryReadinessPanel, {}))
    expect(html).toContain('尚未连接服务，交付证据未读取')
    expect(html).not.toContain('已读取 0 项')
    expect(html).not.toContain('演示')
  })
})
