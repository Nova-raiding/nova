import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeliveryReadinessPanel } from './DeliveryReadinessPanel.js'

describe('DeliveryReadinessPanel capability boundary', () => {
  it('explains platform-owned media evidence without reporting a missing API response', () => {
    const html = renderToStaticMarkup(createElement(DeliveryReadinessPanel, { baseUrl: 'https://merchant.invalid' }))

    expect(html).toContain('由平台运营统一维护')
    expect(html).toContain('商家工作台不读取平台级能力证据')
    expect(html).not.toContain('API 未返回平台媒体规格')
  })
})
