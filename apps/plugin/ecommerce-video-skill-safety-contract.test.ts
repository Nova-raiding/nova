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
  it('does not ask for price unless the merchant wants it shown in the script', () => {
    const intakeStart = source.indexOf('### 阶段1：任务启动')
    const intakeEnd = source.indexOf('\n### 阶段2：需求定义', intakeStart)
    const intake = source.slice(intakeStart, intakeEnd)

    expect(marketplace).toBe(source)
    expect(intake).toContain('价格不是脚本必需资料')
    expect(intake).toContain('只有用户要求脚本展示价格时，才询问并核验当前有效价格')
    expect(intake).not.toMatch(/商品基本信息（名称、品类、价格、卖点）/u)
  })

  it('keeps examples explicitly fictional and production/analytics claims text-only', () => {
    expect(marketplace).toBe(source)
    expect(source).toContain('以下仅展示脚本结构')
    expect(source).toContain('本技能不生成媒体、不编辑或渲染成片')
    expect(source).toContain('不生成成片、不投放、不读取或分析数据')
    expect(source).toContain('本技能不创建或投放实验、不接入分析平台、不读取转化率')
    expect(source).toContain('按用户指定的视频总时长编排并逐镜计时')
    expect(source).toContain('本技能不执行图片分析、知识图谱构建或竞品/行业查询')
    expect(source).toContain('本技能仅登记，不读取图像')
    expect(source).toContain('仅在已有证据支持时展示结果，否则采用中性商品展示')
    expect(source).not.toContain('展示使用产品后的美好生活')
    expect(source).not.toContain('展示目标人群的真实困扰')
    expect(source).not.toContain('适用于抖音短视频')
    expect(source).not.toContain('自动化后期')
    expect(source).not.toContain('测试不同视频版本的转化率')
    expect(source).not.toMatch(/(?:APP远程控制|深层保湿|健康快乐成长|瞬间吸收|一键烹饪)/u)
    expect(source).not.toContain('构建商品知识图谱')
    expect(source).not.toContain('收集产品图片')
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
