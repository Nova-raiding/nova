import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('Merchant Studio product import recovery', () => {
  it('focuses the import error summary after validation or server failure', () => {
    expect(app).toContain('const importErrorRef = useRef<HTMLDivElement>(null)')
    expect(app).toContain('importErrorRef.current?.focus({ preventScroll: true })')
    expect(app).toContain('id="import-product-error"')
    expect(app).toContain('role="alert"')
    expect(app).toContain('aria-live="assertive"')
  })

  it('links invalid fields to the recoverable summary and preserves the draft', () => {
    expect(app).toContain("setImportErrorField('title')")
    expect(app).toContain("setImportErrorField('category')")
    expect(app).toContain("setImportErrorField('price')")
    expect(app).toContain("setImportErrorField('stock')")
    expect(app).toContain('aria-describedby={importError ? \'import-product-error\' : undefined}')
    expect(app).toContain('跳转到需要修正的字段')
    expect(app).toContain('已填写内容会保留。')
  })
})
