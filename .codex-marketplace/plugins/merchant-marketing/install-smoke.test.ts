import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), 'apps/plugin')
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, any>

describe('Codex plugin installation package', () => {
  it('contains the required manifest, skill entry, and MCP companion file', () => {
    const manifest = readJson('.codex-plugin/plugin.json')
    expect(manifest.name).toBe('merchant-marketing')
    expect(manifest.interface.displayName).toBe('大麦')
    expect(manifest.version).toMatch(/^0\.1\.0\+codex\.[0-9]{14}$/)
    expect(manifest.skills).toBe('./skills/')
    expect(manifest.mcpServers).toBe('./.mcp.json')
    expect(manifest.interface.defaultPrompt).toEqual([
      '开始使用大麦：先绑定京东、淘宝、天猫、拼多多、小红书、抖音店铺',
      '查看插件钱包余额并充值，确认生成、图片、视频和发布能力是否已解锁',
      '开始商品营销：选择平台和商品后，按事实确认→内容→主图→审核顺序引导我',
    ])
    expect(manifest.interface.defaultPrompt).toHaveLength(3)
    expect(manifest.entry_skill).toBeUndefined()
    expect(manifest.permissions).toBeUndefined()
    expect(existsSync(resolve(root, 'skills/merchant-marketing/SKILL.md'))).toBe(true)
    expect(existsSync(resolve(root, '.mcp.json'))).toBe(true)
  })

  it('keeps the install package version aligned and points MCP at the configured endpoint', () => {
    const manifest = readJson('.codex-plugin/plugin.json')
    const packageJson = readJson('package.json')
    const mcp = readJson('.mcp.json')
    expect(packageJson.version).toBe(manifest.version)
    expect(mcp.mcpServers['merchant-marketing']).toMatchObject({
      command: 'sh',
      args: ['./mcp/bridge.sh'],
      cwd: '.',
      env: {
        MERCHANT_MCP_BASE_URL: '${MERCHANT_MCP_BASE_URL}',
        MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}',
        MERCHANT_MCP_TOKEN: '${MERCHANT_MCP_TOKEN}',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}',
        MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}',
      },
    })
    expect(existsSync(resolve(root, 'mcp/bridge.mjs'))).toBe(true)
    expect(existsSync(resolve(root, 'mcp/bridge.sh'))).toBe(true)
  })

  it('renders a safe local test checkout without mock wording', () => {
    const recharge = readFileSync(resolve(root, 'ui/recharge.html'), 'utf8')
    expect(recharge).toContain('测试支付')
    expect(recharge).toContain('不会产生真实扣款')
    expect(recharge.toLowerCase()).not.toContain('mock')
  })

  it('documents store authorization before wallet and product-material onboarding', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const firstStep = readme.indexOf('## 安装后第一步')
    expect(firstStep).toBeGreaterThanOrEqual(0)
    const firstStepSection = readme.slice(firstStep, readme.indexOf('\n## ', firstStep + 3) < 0 ? undefined : readme.indexOf('\n## ', firstStep + 3))
    expect(firstStepSection).toContain('六个平台')
    expect(firstStepSection).toContain('platform.connect')
    expect(firstStepSection).toContain('workspace.health')
    expect(firstStepSection).toContain('billing.status')
    expect(firstStepSection.indexOf('billing.status')).toBeGreaterThan(firstStepSection.indexOf('platform.connect'))
    expect(firstStepSection.indexOf('上传我的商品图片和资料')).toBeGreaterThan(firstStepSection.indexOf('billing.status'))
  })

  it('keeps image generation on the business relay instead of the host image tool', () => {
    const skill = readFileSync(resolve(root, 'skills/merchant-marketing/SKILL.md'), 'utf8')
    expect(skill).toContain('统一使用 `catalog.image.generate` 的服务端适配器')
    expect(skill).toContain('不得调用宿主原生 `image_gen` 绕过业务 relay')
  })

  it('keeps the installed marketplace mirror aligned', () => {
    const marketplaceRoot = resolve(process.cwd(), '.codex-marketplace/plugins/merchant-marketing')
    expect(readFileSync(resolve(root, 'README.md'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, 'README.md'), 'utf8'))
    expect(readFileSync(resolve(root, 'skills/merchant-marketing/SKILL.md'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, 'skills/merchant-marketing/SKILL.md'), 'utf8'))
    expect(readFileSync(resolve(root, 'mcp/bridge.mjs'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, 'mcp/bridge.mjs'), 'utf8'))
  })
})
