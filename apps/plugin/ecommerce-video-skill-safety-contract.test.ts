import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const source = readFileSync(resolve(root, 'apps/plugin/skills/ecommerce-video-marketing/SKILL.md'), 'utf8')
const marketplace = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-video-marketing/SKILL.md'), 'utf8')
const videoReferences = ['video_guide.md', 'video_templates.md'].map(file => ({
  source: readFileSync(resolve(root, 'apps/plugin/skills/ecommerce-video-marketing/references', file), 'utf8'),
  marketplace: readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-video-marketing/references', file), 'utf8'),
}))

describe('ecommerce video skill capability and fact boundaries', () => {
  it('keeps examples explicitly fictional and production/analytics claims text-only', () => {
    expect(marketplace).toBe(source)
    expect(source).toContain('以下示例均为虚构占位材料')
    expect(source).toContain('不生成或渲染视频，不执行投放')
    expect(source).toContain('不创建或投放实验、不接入分析平台、不读取转化率')
    expect(source).toContain('用户指定的视频总时长编排并逐镜计时')
    expect(source).not.toContain('适用于抖音短视频')
    expect(source).not.toContain('自动化后期')
    expect(source).not.toContain('测试不同视频版本的转化率')
  })

  it('keeps packaged video references mirrored and evidence-led', () => {
    for (const reference of videoReferences) {
      expect(reference.marketplace).toBe(reference.source)
      expect(reference.source).toContain('待确认')
      expect(reference.source).toContain('总时长')
      expect(reference.source).toContain('可审阅')
      expect(reference.source).not.toMatch(/(?:年龄|性别|职业|收入水平)：\s*(?:\d|男|女|中产)/u)
      expect(reference.source).not.toMatch(/(?:APP远程控制|AI智能调节|深层保湿|音质出众|健康天然|高转化率)/u)
      expect(reference.source).not.toMatch(/(?:自动化后期|自动生成字幕|投放不同版本|监测转化率)/u)
    }
  })
})
