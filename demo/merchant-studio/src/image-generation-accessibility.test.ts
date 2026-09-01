import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('image generation desktop accessibility contract', () => {
  it('keeps failed candidates recoverable without losing their evidence', () => {
    expect(app).toContain('当前任务状态和候选门禁仍保留')
    expect(app).toContain('aria-label={`重新读取图片候选 ${index + 1}`}')
    expect(app).toContain('setImageReloads')
    expect(app).toContain('image-candidate-fallback" role="alert"')
  })

  it('makes candidate images and selection feedback understandable to assistive technology', () => {
    expect(app).toContain('alt={`图片候选 ${index + 1}，${gate?.selectable ? \'可进入后续选择\' : \'尚不可选择\'}`}')
    expect(app).toContain('role="status" aria-live="polite" aria-atomic="true">已选择')
    expect(app).toContain('disabled={!gate?.selectable || selectionState === \'submitting\'}')
  })
})
