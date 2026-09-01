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
    expect(app).toContain('aria-describedby={!gate?.selectable ? `candidate-gate-${index}` : undefined}')
    expect(app).toContain('不可选择：{gate?.blockers.length ? gate.blockers.join(\'；\') : \'尚未满足全部候选门禁\'}')
  })

  it('moves focus to a submitted selection error without disturbing polling focus', () => {
    expect(app).toContain('const selectionErrorRef = useRef<HTMLDivElement>(null)')
    expect(app).toContain('window.requestAnimationFrame(() => selectionErrorRef.current?.focus())')
    expect(app).toContain('ref={selectionErrorRef} tabIndex={selectionState === \'failed\' ? -1 : undefined}')
  })

  it('keeps the initial async wait visibly occupied without adding duplicate announcements', () => {
    expect(app).toContain('{!job && loading && <div className="image-candidate-loading" aria-hidden="true">')
    expect(app).toContain('image-candidate-skeleton-${slot}')
    expect(app).toContain('aria-busy={loading}')
  })

  it('announces the six-candidate limit and blocked candidate recovery path', () => {
    expect(app).toContain('最多选择 6 张候选图，请先取消一张再继续。')
    expect(app).toContain('这张候选图尚未满足归档、安全扫描、权益、真实性或人工审核门禁，暂不能选择。')
    expect(app).toContain('{selectionNotice ? `。${selectionNotice}` : \'\'}')
  })
})
