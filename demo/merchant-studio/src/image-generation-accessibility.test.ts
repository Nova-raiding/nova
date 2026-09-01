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

  it('moves focus to a user-triggered safe-retry error while retaining the trusted job', () => {
    expect(app).toContain('const retryErrorFocusRequestedRef = useRef(false)')
    expect(app).toContain('retryErrorFocusRequestedRef.current = true')
    expect(app).toContain('(!job || retryErrorFocusRequestedRef.current)')
    expect(app).toContain('retryErrorFocusRequestedRef.current = false')
  })

  it('keeps the initial async wait visibly occupied without adding duplicate announcements', () => {
    expect(app).toContain('{!job && loading && <div className="image-candidate-loading" aria-hidden="true">')
    expect(app).toContain('image-candidate-skeleton-${slot}')
    expect(app).toContain('aria-busy={loading}')
  })

  it('exposes missing API or relay configuration as a focused recoverable blocker', () => {
    expect(app).toContain('imageJobConfigurationErrorRef')
    expect(app).toContain('role="alert" tabIndex={-1} aria-labelledby="image-job-config-title"')
    expect(app).toContain('尚未配置商家 API 或模型中转，系统不会读取、生成或扣费。')
    expect(app).toContain('请联系管理员完成测试环境配置后，再刷新此页面。')
    expect(app).toContain('模型中转配置尚未就绪')
    expect(app).toContain('API 返回配置阻断')
    expect(app).toContain('setConfigurationError(isImageGenerationConfigurationError(cause))')
  })

  it('names and assertively announces task-read failures while retaining recovery', () => {
    expect(app).toContain('aria-live="assertive" aria-atomic="true" aria-labelledby="image-job-read-error-title" aria-describedby="image-job-read-error-description"')
    expect(app).toContain('id="image-job-read-error-title">图片任务状态暂时不可用</strong>')
    expect(app).toContain('id="image-job-read-error-description">任务状态读取失败：{error}。已保留上次可信状态；请刷新任务状态后继续。</span>')
  })

  it('focuses image generation form errors and links them to both fields', () => {
    expect(app).toContain('const imageGenerationErrorRef = useRef<HTMLDivElement>(null)')
    expect(app).toContain('window.requestAnimationFrame(() => imageGenerationErrorRef.current?.focus({ preventScroll: true }))')
    expect(app).toContain('id="image-generation-error" ref={imageGenerationErrorRef}')
    expect(app).toContain('role="alert" tabIndex={-1} aria-live="assertive" aria-atomic="true"')
    expect(app).toContain('aria-describedby={imageGenerationError ? \'image-generation-error\' : undefined}')
    expect(app).toContain('请修正表单后重新提交。')
    expect(app).toContain("const [imageGenerationErrorField, setImageGenerationErrorField] = useState<'direction' | 'count' | null>(null)")
    expect(app).toContain("aria-invalid={imageGenerationErrorField === 'direction'}")
    expect(app).toContain("aria-invalid={imageGenerationErrorField === 'count'}")
    expect(app).toContain('跳转到需要修正的字段')
  })

  it('announces the six-candidate limit and blocked candidate recovery path', () => {
    expect(app).toContain('最多选择 6 张候选图，请先取消一张再继续。')
    expect(app).toContain('这张候选图尚未满足归档、安全扫描、权益、真实性或人工审核门禁，暂不能选择。')
    expect(app).toContain('{selectionNotice ? `。${selectionNotice}` : \'\'}')
  })

  it('derives the visual selection state from the controlled selection model', () => {
    expect(app).toContain("const selected = selectedVisualRefs.includes(visualRef)")
    expect(app).toContain("' candidate-selected' : ''")
  })
})
