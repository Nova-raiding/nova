import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { manualPublishStateLabel } from './App'

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

  it('labels the durable manual evidence states for merchants', () => {
    expect(manualPublishStateLabel('export_ready')).toBe('待人工发布')
    expect(manualPublishStateLabel('manual_publish_in_progress')).toBe('人工发布中')
    expect(manualPublishStateLabel('manual_publish_reported')).toBe('已报告，待复核')
    expect(manualPublishStateLabel('manual_review_required')).toBe('需人工复核')
    expect(manualPublishStateLabel('unexpected')).toBe('状态待确认')
  })

  it('reads and renders manual publish records instead of hiding them behind publish jobs', () => {
    expect(app).toContain('fetchManualPublishRecords(baseUrl)')
    expect(app).toContain('人工发布记录')
    expect(app).toContain('人工记录不等于平台 API 回执')
  })
})
