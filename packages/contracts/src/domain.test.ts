import { describe, expect, it } from 'vitest'
import { PLATFORMS, PUBLISH_STATES, TASK_STATES, type Platform, type PublishState, type TaskState } from './index.js'

describe('domain state contracts', () => {
  it('covers every platform profile separately', () => {
    expect(PLATFORMS).toEqual(['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'])
    const platform: Platform = 'tmall'
    expect(platform).toBe('tmall')
  })

  it('contains the publish unknown/reconcile safety branch', () => {
    const taskState: TaskState = 'publish_prepared'
    const publishState: PublishState = 'unknown'
    expect(TASK_STATES).toContain(taskState)
    expect(PUBLISH_STATES).toEqual(expect.arrayContaining([publishState, 'reconciling', 'manual_attention']))
  })
})
