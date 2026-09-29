import { describe, expect, it } from 'vitest'
import { OpenAICompatibleContentGenerator, validateContentSchema } from './generator.js'

const valid = {
  title: '跑鞋分镜候选',
  detail: '以下画面和表达均为待确认创意。',
  sellingPoints: ['展示商品外观，具体卖点待确认'],
  storyboard: [
    { durationSeconds: 3, visual: '商品名称字卡进入画面', subtitle: '商品信息待确认', voiceover: '先核对商品资料' },
    { durationSeconds: 4, visual: '多角度空镜位置示意', subtitle: '画面素材待补充', voiceover: '按已确认素材安排展示' },
    { durationSeconds: 3, visual: '结尾审核提示', subtitle: '确认事实后完善', voiceover: '确认后再形成正式版本' },
  ],
}

describe('video storyboard candidate contract', () => {
  it('accepts 3-5 shots with duration, visual, subtitle and voiceover', () => {
    expect(validateContentSchema(valid, 'test', { candidateOnly: true, candidateFormat: 'video_storyboard' }).storyboard).toHaveLength(3)
  })

  it.each([
    [{ ...valid, storyboard: valid.storyboard.slice(0, 2) }, '3 至 5'],
    [{ ...valid, storyboard: [{ ...valid.storyboard[0], voiceover: '' }, ...valid.storyboard.slice(1)] }, 'voiceover'],
    [{ ...valid, storyboard: [{ ...valid.storyboard[0], durationSeconds: 8 }, ...valid.storyboard.slice(1)] }, '2 至 6'],
    [{ ...valid, detail: '带来卓越体验' }, '卓越体验'],
  ])('fails closed for malformed or unsupported claims', (candidate, expected) => {
    expect(() => validateContentSchema(candidate, 'test', { candidateOnly: true, candidateFormat: 'video_storyboard' })).toThrow(expected)
  })

  it('sends the strict storyboard output contract without changing ordinary copy', async () => {
    const requests: Array<Record<string, unknown>> = []
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://relay.example', apiKey: 'secret', model: 'model',
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-oneapi-request-id': 'req-storyboard' } })
      },
      usageSink: async () => ({ recorded: true, costEvidence: true }),
    })
    await generator.generate({ platform: 'douyin', candidateOnly: true, candidateFormat: 'video_storyboard', product: { title: '跑鞋', stock: 0, skuCount: 0 }, directionId: '生成视频分镜' })
    const message = ((requests[0]?.messages as Array<{ content: string }>)[0]?.content) ?? ''
    expect(message).toContain('3 至 5 个镜头')
    expect(message).toContain('独特设计')
    expect(message).toContain('卓越体验')
    expect(message).toContain('品质生活')
  })
})
