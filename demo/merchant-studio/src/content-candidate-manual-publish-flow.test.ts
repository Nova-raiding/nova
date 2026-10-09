import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('content candidate to manual publish workflow', () => {
  it('continues from a selected image candidate to the new content version review', () => {
    expect(app).toContain('进入新版本审核')
    expect(app).toContain("urlForMerchantRoute(window.location, { page: 'task', target: { kind: 'task', taskId: reviewTaskId } })")
  })

  it('describes publish confirmation as creating a manual publish task, not a platform receipt', () => {
    expect(app).toContain('提交人工发布任务')
    expect(app).toContain('当前不代表平台已受理或已生效')
    expect(app).not.toContain('我确认将审核后的内容写入')
  })

  it('keeps publish creation in the reviewed task flow and describes its manual status accurately', () => {
    expect(app).toContain('preparePublish(apiBaseUrl, taskContext.task.id)')
    expect(app).toContain('confirmPublish(')
    expect(app).toContain('onComplete={completePublish}')
    expect(app).toContain('需由运营人员完成平台操作并回填证据，当前不代表平台已受理或已生效。')
  })

  it('returns to the task queue after creating a manual publish job so its history is immediately reachable', () => {
    expect(app).toContain("navigateTo('task', { clearContext: true, publishJobId: jobId })")
    expect(app).not.toContain("navigateTo('products')\n    showToast(\n      `人工发布任务已创建：${jobId}")
    expect(app).toContain('<PublishHistoryPanel baseUrl={baseUrl} />')
  })
})
