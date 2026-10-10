import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const source = readFileSync(resolve(root, 'apps/plugin/skills/ecommerce-image-workflow/SKILL.md'), 'utf8')
const marketplace = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-image-workflow/SKILL.md'), 'utf8')
const merchant = readFileSync(resolve(root, 'apps/plugin/skills/merchant-marketing/SKILL.md'), 'utf8')

describe('ecommerce image workflow routing contract', () => {
  it('keeps source and marketplace routing identical', () => {
    expect(marketplace).toBe(source)
  })

  it('separates planning, explicit single-image work, and confirmed image sets', () => {
    expect(source).toContain('用户只说“做电商图”“设计一下”')
    expect(source).toContain('只问一个问题确认交付物')
    expect(source).toContain('只有用户明确要求生成或修改图片时')
    expect(source).toContain('用户确认整组方案后')
    expect(merchant).toContain('“设计/设计一下”本身不等于要求生成图片')
    expect(merchant).toContain('只有用户明确接受该方案，或明确说“按这个方案开始生成”时才开始生成')
  })

  it('requires the live Merchant MCP tools and server gates before media work', () => {
    expect(source).toContain('每次实际媒体操作前检查当前会话 `tools/list` 和工具参数')
    expect(source).toContain('实际上传、生成、查询和交付只通过 `merchant-marketing` 当前 MCP 与服务端中转')
    expect(source).toContain('不调用宿主图片工具、第三方 provider/API/CLI 或本地生成脚本')
    expect(source).toContain('工具失败、状态未知、费用结算失败、扫描/归档证据缺失时停止')
  })
})
