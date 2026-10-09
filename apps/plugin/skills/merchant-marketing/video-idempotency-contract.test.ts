import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const sourceBridgePath = new URL('../../mcp/bridge.mjs', import.meta.url)
const sourceSkillPath = new URL('./SKILL.md', import.meta.url)
const mirrorRoot = new URL('../../../../.codex-marketplace/plugins/merchant-marketing/', import.meta.url)

describe('video rendering idempotency guidance', () => {
  it('keeps source and marketplace tool descriptions and skill instructions aligned', async () => {
    const [sourceBridge, mirrorBridge, sourceSkill, mirrorSkill] = await Promise.all([
      readFile(sourceBridgePath, 'utf8'),
      readFile(new URL('mcp/bridge.mjs', mirrorRoot), 'utf8'),
      readFile(sourceSkillPath, 'utf8'),
      readFile(new URL('skills/merchant-marketing/SKILL.md', mirrorRoot), 'utf8'),
    ])
    const videoDescription = (bridge: string) => bridge.match(/'multimodal\.video\.request': \{\s*description: '([^']+)'/u)?.[1] ?? ''

    expect(videoDescription(sourceBridge)).toBeTruthy()
    expect(videoDescription(sourceBridge)).toBe(videoDescription(mirrorBridge))
    expect(videoDescription(sourceBridge)).toContain('每个新渲染意图生成新的随机 idempotency_key')
    expect(videoDescription(sourceBridge)).toContain('同一请求重试必须复用原 key')
    expect(videoDescription(sourceBridge)).toContain('修改请求意图必须换新 key')

    expect(sourceSkill).toBe(mirrorSkill)
    expect(sourceSkill).toContain('每个新的渲染意图都生成一个新的随机 `idempotency_key`')
    expect(sourceSkill).toContain('同一请求重试时必须复用原 key')
    expect(sourceSkill).toContain('任何请求意图变更都必须换新 key')
  })
})
