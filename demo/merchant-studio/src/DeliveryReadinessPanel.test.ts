import { createElement } from 'react'
import { readFileSync } from 'node:fs'
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

  it('keeps the delivery error summary as the recovery focus target', () => {
    const source = String.raw`<div ref={errorRef} id="delivery-readiness-error" className="inline-error" role="alert" tabIndex={-1} aria-labelledby="delivery-readiness-error-title" aria-describedby="delivery-readiness-error-description">`
    const component = readFileSync(new URL('./DeliveryReadinessPanel.tsx', import.meta.url), 'utf8')
    expect(component).toContain(source)
    expect(component).toContain("errorRef.current : panelRef.current)?.focus({ preventScroll: true })")
    expect(component).toContain('type="button"')
    expect(component).toContain('<AlertCircle size={16} aria-hidden="true"/>')
  })
})
