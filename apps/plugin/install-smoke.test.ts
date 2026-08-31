import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), 'apps/plugin')
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, any>
const inheritedRuntimeEnv = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'CODEX_NODE_BIN',
  'CODEX_MCP_NODE_PATH',
  'NODE_ENV',
  'MERCHANT_MCP_BASE_URL',
  'MERCHANT_WORKSPACE_ID',
  'MERCHANT_MCP_TOKEN',
  'MERCHANT_ALLOW_FIXTURE_FALLBACK',
  'MERCHANT_MCP_WRITE_ENABLED',
  'MERCHANT_RULE_APPROVAL_TOKEN',
  'MERCHANT_ARTIFACT_DIR',
  'MERCHANT_MCP_TIMEOUT_MS',
  'MERCHANT_MCP_RETRY_ATTEMPTS',
  'MERCHANT_MCP_RETRY_DELAY_MS',
  'MERCHANT_ASSET_RESOURCE_DOMAINS',
]

describe('Codex plugin installation package', () => {
  it('contains the required manifest, skill entry, and MCP companion file', () => {
    const manifest = readJson('.codex-plugin/plugin.json')
    expect(manifest.name).toBe('merchant-marketing')
    expect(manifest.interface.displayName).toBe('大麦')
    expect(manifest.version).toMatch(/^0\.1\.0\+codex\.[0-9]{14}$/)
    expect(manifest.skills).toBe('./skills/')
    expect(manifest.mcpServers).toBe('./.mcp.json')
    expect(manifest.interface.defaultPrompt).toEqual([
      '开始使用大麦：先读取当前工作区和店铺连接状态，再让我选择一家店铺',
      '查看插件钱包余额；余额不足时告诉我唯一的下一步',
      '开始商品营销：先让我选择一个平台和商品，然后每一步都等我确认',
    ])
    expect(manifest.interface.defaultPrompt).toHaveLength(3)
    expect(manifest.entry_skill).toBeUndefined()
    expect(manifest.permissions).toBeUndefined()
    expect(existsSync(resolve(root, 'skills/merchant-marketing/SKILL.md'))).toBe(true)
    expect(existsSync(resolve(root, '.mcp.json'))).toBe(true)
  })

  it('keeps the install package version aligned and inherits runtime MCP settings', () => {
    const manifest = readJson('.codex-plugin/plugin.json')
    const packageJson = readJson('package.json')
    const mcp = readJson('.mcp.json')
    expect(packageJson.version).toBe(manifest.version)
    expect(packageJson.engines).toEqual({ node: '>=18' })
    expect(packageJson.merchantRuntime).toMatchObject({
      desktopHost: 'ChatGPT.app',
      supportedDesktopPlatforms: ['darwin'],
      environmentRecovery: 'macOS launchctl user session',
    })
    const server = mcp.mcpServers['merchant-marketing']
    expect(server).toMatchObject({
      command: 'sh',
      args: ['./mcp/bridge.sh'],
      cwd: '.',
      env: {
        MERCHANT_MCP_ROLE: 'viewer',
        MERCHANT_ACTOR_ID: 'codex-app-user',
      },
    })
    expect(server.env_vars).toEqual(inheritedRuntimeEnv)
    expect(server.env).not.toHaveProperty('MERCHANT_RULE_APPROVAL_TOKEN')
    expect(server.env).not.toHaveProperty('MERCHANT_ARTIFACT_DIR')
    for (const inherited of ['MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID', 'MERCHANT_MCP_TOKEN', 'MERCHANT_ALLOW_FIXTURE_FALLBACK', 'MERCHANT_MCP_WRITE_ENABLED']) {
      expect(server.env).not.toHaveProperty(inherited)
    }
    expect(existsSync(resolve(root, 'mcp/bridge.mjs'))).toBe(true)
    expect(existsSync(resolve(root, 'mcp/bridge.sh'))).toBe(true)
    expect(readFileSync(resolve(root, 'mcp/bridge.mjs'), 'utf8')).toContain('MERCHANT_MCP_TIMEOUT_MS ?? 180000')
  })

  it('recovers local merchant settings from the macOS user session without exposing them in the manifest', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-launchctl-'))
    const launchctl = resolve(directory, 'launchctl')
    const uname = resolve(directory, 'uname')
    const node = resolve(directory, 'node-probe')
    writeFileSync(launchctl, `#!/bin/sh\ncase "$2" in\n  MERCHANT_MCP_BASE_URL) printf '%s' 'http://127.0.0.1:8790' ;;\n  MERCHANT_WORKSPACE_ID) printf '%s' 'ws_demo' ;;\n  MERCHANT_MCP_TOKEN) printf '%s' 'test-token' ;;\n  MERCHANT_ALLOW_FIXTURE_FALLBACK) printf '%s' 'true' ;;\n  MERCHANT_MCP_WRITE_ENABLED) printf '%s' 'false' ;;\nesac\n`)
    writeFileSync(uname, `#!/bin/sh\nprintf '%s\n' Darwin\n`)
    writeFileSync(node, `#!/bin/sh\ncase "\${1:-}" in\n  -e) exit 0 ;;\n  -p) printf '%s' '22.0.0'; exit 0 ;;\nesac\nprintf '%s|%s|%s|%s|%s' "$MERCHANT_MCP_BASE_URL" "$MERCHANT_WORKSPACE_ID" "$MERCHANT_MCP_TOKEN" "$MERCHANT_ALLOW_FIXTURE_FALLBACK" "$MERCHANT_MCP_WRITE_ENABLED"\n`)
    chmodSync(launchctl, 0o755)
    chmodSync(uname, 0o755)
    chmodSync(node, 0o755)
    try {
      const result = spawnSync('sh', [resolve(root, 'mcp/bridge.sh')], {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:/usr/bin:/bin`,
          CODEX_NODE_BIN: node,
          MERCHANT_MCP_BASE_URL: '',
          MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}',
          MERCHANT_MCP_TOKEN: 'host-token',
        },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('http://127.0.0.1:8790|ws_demo|host-token|true|false')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a configured Node runtime older than 18 before starting the bridge', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-old-node-'))
    const node = resolve(directory, 'node-16')
    writeFileSync(node, `#!/bin/sh\ncase "\${1:-}" in\n  -e) exit 1 ;;\n  -p) printf '%s' '16.20.2'; exit 0 ;;\nesac\nexit 99\n`)
    chmodSync(node, 0o755)
    try {
      const result = spawnSync('sh', [resolve(root, 'mcp/bridge.sh')], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', CODEX_NODE_BIN: node },
      })
      expect(result.status).toBe(126)
      expect(result.stderr).toContain('requires Node.js 18 or newer')
      expect(result.stderr).toContain('16.20.2')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['MERCHANT_ALLOW_FIXTURE_FALLBACK', 'MERCHANT_ALLOW_FIXTURE_FALLBACK=true'],
    ['MERCHANT_MCP_WRITE_ENABLED', 'interactive confirmation'],
  ])('keeps production fail-closed when %s is enabled', (name, expectedMessage) => {
    const result = spawnSync('sh', [resolve(root, 'mcp/bridge.sh')], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        NODE_ENV: 'production',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
        [name]: 'true',
      },
    })
    expect(result.status).toBe(78)
    expect(result.stderr).toContain(expectedMessage)
  })

  it('renders an accessible ChatGPT recharge card with clear payment states', () => {
    const recharge = readFileSync(resolve(root, 'ui/recharge.html'), 'utf8')
    expect(recharge).toContain('到账以服务端状态为准')
    expect(recharge).toContain('call("billing.recharge.create"')
    expect(recharge).toContain('call("billing.recharge.get"')
    expect(recharge).toContain('call("billing.export"')
    expect(recharge.toLowerCase()).not.toContain('mock')
    expect(recharge).not.toMatch(/Codex/iu)
    expect(recharge).toContain('role="radiogroup"')
    expect(recharge).toContain('role="radio"')
    expect(recharge).toContain('aria-checked="true"')
    expect(recharge).toContain('aria-pressed="true"')
    expect(recharge).toContain('role="alert"')
    expect(recharge).toContain('aria-busy="false"')
    expect(recharge).toContain('aria-labelledby="checkoutTitle"')
    expect(recharge).toContain('data-channel="alipay"')
    expect(recharge).toMatch(/payment_mode\s*===\s*["']provider["']/u)
    for (const status of ['已到账', '待支付', '未成功', '已关闭', '已退款']) expect(recharge).toContain(status)
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

  it('keeps the MCP startup contract marketplace mirror aligned', () => {
    const marketplaceRoot = resolve(process.cwd(), '.codex-marketplace/plugins/merchant-marketing')
    expect(readFileSync(resolve(root, '.mcp.json'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, '.mcp.json'), 'utf8'))
    expect(readFileSync(resolve(root, 'mcp/bridge.sh'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, 'mcp/bridge.sh'), 'utf8'))
    expect(readFileSync(resolve(root, 'package.json'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, 'package.json'), 'utf8'))
  })
})
