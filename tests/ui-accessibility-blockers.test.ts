import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const imageEditorPath = 'apps/plugin/ui/image-local-edit.html'
const marketplaceImageEditorPath = '.codex-marketplace/plugins/merchant-marketing/ui/image-local-edit.html'

describe('UI accessibility blocker contracts', () => {
  it('keeps the image editor and marketplace mirror byte-identical', () => {
    expect(readFileSync(marketplaceImageEditorPath)).toEqual(readFileSync(imageEditorPath))
  })

  it('keeps only the operable selection in the image editor tab order', () => {
    const html = readFileSync(imageEditorPath, 'utf8')
    expect(html).toContain('<div id="stage" class="stage">')
    expect(html).not.toMatch(/id="stage"[^>]*tabindex=/u)
    expect(html).toMatch(/id="selection"[^>]*tabindex="0"[^>]*role="group"/u)
    expect(html).toContain("$('selection').addEventListener('keydown'")
  })

  it('binds validation errors to fields and focuses the failing field', () => {
    const html = readFileSync(imageEditorPath, 'utf8')
    expect(html).toContain("field.setAttribute('aria-invalid','true')")
    expect(html).toContain("field.setAttribute('aria-describedby',describedBy.join(' '))")
    expect(html).toContain("field.focus()")
    expect(html).toContain("details.open=true")
    expect(html).toContain("className='field-error'")
  })

  it('keeps Ops mobile connection controls at least 44px tall', () => {
    const css = readFileSync('apps/ops-console/src/styles.css', 'utf8')
    expect(css).toMatch(/@media \(max-width: 991px\) \{ \.ops-connection-form \.ant-input, \.ops-connection-form \.ant-input-affix-wrapper \{ min-height: 44px; \}/u)
    expect(css).toMatch(/\.ops-connection-form \.ant-input-password-icon \{[^}]*min-width: 44px; min-height: 44px;/u)
  })
})
