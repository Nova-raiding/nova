import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  'DEPLOY_ENV',
  'MERCHANT_MCP_BASE_URL',
  'MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES',
  'MERCHANT_WORKSPACE_ID',
  'MERCHANT_MCP_TOKEN',
  'MERCHANT_MCP_TOKEN_SOURCE',
  'MERCHANT_STRICT_AUTH',
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
    expect(manifest.interface.displayName).toBe('Store Nova')
    expect(manifest.version).toMatch(/^0\.1\.0\+codex\.[0-9]{14}$/)
    expect(manifest.skills).toBe('./skills/')
    expect(manifest.mcpServers).toBe('./.mcp.json')
    expect(manifest.interface.defaultPrompt).toEqual([
      '@Store Nova 开始使用：从公开商品链接或手工资料开始，带我完成内容生产、审核和导出',
      '用我上传的商品图片做一张可审阅主图；还没有图片就先告诉我怎么上传',
      '为我的商品策划第一份营销素材，先核对我提供的商品资料',
    ])
    expect(manifest.interface.defaultPrompt).toHaveLength(3)
    expect(manifest.entry_skill).toBeUndefined()
    expect(manifest.permissions).toBeUndefined()
    expect(existsSync(resolve(root, 'skills/merchant-marketing/SKILL.md'))).toBe(true)
    expect(existsSync(resolve(root, 'skills/ecommerce-video-marketing/SKILL.md'))).toBe(true)
    expect(existsSync(resolve(root, 'skills/storyboard-prompt-assistant/SKILL.md'))).toBe(true)
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
    })
    expect(server).not.toHaveProperty('env')
    expect(server.env_vars).toEqual(inheritedRuntimeEnv)
    expect(server.env_vars).not.toContain('MERCHANT_MCP_ROLE')
    expect(server.env_vars).not.toContain('MERCHANT_ACTOR_ID')
    expect(existsSync(resolve(root, 'mcp/bridge.mjs'))).toBe(true)
    expect(existsSync(resolve(root, 'mcp/bridge.sh'))).toBe(true)
    expect(readFileSync(resolve(root, 'mcp/bridge.mjs'), 'utf8')).toContain('MERCHANT_MCP_TIMEOUT_MS ?? 360000')
  })

  it('refuses an install when the registered marketplace targets a different checkout', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-marketplace-check-'))
    const expected = resolve(directory, 'expected')
    const other = resolve(directory, 'other')
    const fakeCodex = resolve(directory, 'codex-list')
    try {
      mkdirSync(expected)
      mkdirSync(other)
      writeFileSync(resolve(expected, 'marketplace.json'), JSON.stringify({ name: 'merchant-local' }))
      writeFileSync(fakeCodex, `#!/bin/sh\nprintf 'MARKETPLACE ROOT\\nmerchant-local ${other}\\n'\n`)
      chmodSync(fakeCodex, 0o755)
      const check = (registered: string) => {
        writeFileSync(fakeCodex, `#!/bin/sh\nprintf 'MARKETPLACE ROOT\\nmerchant-local ${registered}\\n'\n`)
        return spawnSync(process.execPath, [resolve(root, 'scripts/verify-marketplace-source.mjs'), '--expected', expected, '--codex', fakeCodex], { encoding: 'utf8' })
      }
      const wrong = check(other)
      expect(wrong.status).toBe(1)
      expect(JSON.parse(wrong.stdout)).toMatchObject({ ok: false, reason: 'marketplace_points_to_different_checkout' })
      const correct = check(expected)
      expect(correct.status).toBe(0)
      expect(JSON.parse(correct.stdout)).toMatchObject({ ok: true, reason: null })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers local merchant settings from the macOS user session without exposing them in the manifest', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-launchctl-'))
    const launchctl = resolve(directory, 'launchctl')
    const uname = resolve(directory, 'uname')
    const node = resolve(directory, 'node-probe')
    writeFileSync(launchctl, `#!/bin/sh\ncase "$2" in\n  MERCHANT_MCP_BASE_URL) printf '%s' 'http://127.0.0.1:8790' ;;\n  MERCHANT_WORKSPACE_ID) printf '%s' 'ws_demo' ;;\n  MERCHANT_MCP_TOKEN) printf '%s' 'test-token' ;;\n  MERCHANT_STRICT_AUTH) printf '%s' 'true' ;;\n  MERCHANT_ALLOW_FIXTURE_FALLBACK) printf '%s' 'true' ;;\n  MERCHANT_MCP_WRITE_ENABLED) printf '%s' 'false' ;;\n  MERCHANT_ASSET_RESOURCE_DOMAINS) printf '%s' 'https://assets.example.test' ;;\nesac\n`)
    writeFileSync(uname, `#!/bin/sh\nprintf '%s\n' Darwin\n`)
    writeFileSync(node, `#!/bin/sh\ncase "\${1:-}" in\n  -e) exit 0 ;;\n  -p) printf '%s' '22.0.0'; exit 0 ;;\nesac\nprintf '%s|%s|%s|%s|%s|%s|%s' "$MERCHANT_MCP_BASE_URL" "$MERCHANT_WORKSPACE_ID" "$MERCHANT_MCP_TOKEN" "$MERCHANT_STRICT_AUTH" "$MERCHANT_ALLOW_FIXTURE_FALLBACK" "$MERCHANT_MCP_WRITE_ENABLED" "$MERCHANT_ASSET_RESOURCE_DOMAINS"\n`)
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
          MERCHANT_STRICT_AUTH: '${MERCHANT_STRICT_AUTH}',
        },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('http://127.0.0.1:8790|ws_demo|host-token|true|true|false|https://assets.example.test')
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

  it.each([
    ['MERCHANT_ALLOW_FIXTURE_FALLBACK', 'true', 'MERCHANT_ALLOW_FIXTURE_FALLBACK=true'],
    ['MERCHANT_MCP_WRITE_ENABLED', 'true', 'interactive confirmation'],
  ])('does not let a stale launchd deployment environment downgrade explicit production when %s is enabled', (name, value, expectedMessage) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-launchctl-production-'))
    const launchctl = resolve(directory, 'launchctl')
    const uname = resolve(directory, 'uname')
    writeFileSync(launchctl, `#!/bin/sh
case "$2" in
  DEPLOY_ENV) printf '%s' 'development' ;;
esac
`)
    writeFileSync(uname, `#!/bin/sh
printf '%s\n' Darwin
`)
    chmodSync(launchctl, 0o755)
    chmodSync(uname, 0o755)
    try {
      const result = spawnSync('sh', [resolve(root, 'mcp/bridge.sh')], {
        encoding: 'utf8',
        env: { PATH: `${directory}:/usr/bin:/bin`, NODE_ENV: 'production', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false', MERCHANT_MCP_WRITE_ENABLED: 'false', [name]: value },
      })
      expect(result.status).toBe(78)
      expect(result.stderr).toContain(expectedMessage)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('renders an accessible ChatGPT creative-point recovery card without client-authored payment actions', () => {
    const recharge = readFileSync(resolve(root, 'ui/recharge.html'), 'utf8')
    const catalogStart = recharge.indexOf('function catalogHtml')
    const catalogEnd = recharge.indexOf('function safePaymentUrl', catalogStart)
    const catalogRenderer = recharge.slice(catalogStart, catalogEnd)
    expect(recharge).toContain('支付成功也必须等待 grant 到账和新 access revision')
    expect(recharge).not.toContain('call("billing.recharge.create"')
    expect(recharge).not.toMatch(/data-amount|customAmount|createOrder/u)
    expect(recharge).toContain('服务端授权的恢复入口')
    expect(recharge).toContain('余额状态待确认时会保持“待确认”')
    expect(recharge).not.toContain('balance_state=unknown')
    expect(recharge).not.toContain('unknown: "未知"')
    expect(recharge).toContain('call("billing.recharge.list"')
    expect(recharge).toContain('function safePaymentUrl')
    expect(recharge).toContain('打开支付入口')
    expect(recharge).toContain('noopener noreferrer')
    expect(recharge).toMatch(/url\.username.*url\.password.*url\.hash/su)
    // Detailed orders, transactions, usage and exports belong in the merchant
    // desktop workspace. The ChatGPT surface only exposes payment state and
    // a server-authorized recovery action.
    expect(recharge).not.toMatch(/call\("billing\.(?:transactions|model-usage\.statement|export)"/u)
    expect(recharge).not.toMatch(/amount_cny|customer_charge_cny|deducted_points|quoted_points|total_tokens/u)
    expect(recharge.toLowerCase()).not.toContain('mock')
    expect(recharge).not.toMatch(/Codex/iu)
    expect(recharge).toContain('aria-pressed="true"')
    expect(recharge).toContain('role="alert"')
    expect(recharge).toContain('role="status"')
    expect(recharge).toContain('aria-busy="false"')
    expect(recharge).not.toMatch(/role="radio(group)?"|aria-checked|checkoutTitle|data-channel|payment_mode/u)
    expect(catalogStart).toBeGreaterThanOrEqual(0)
    expect(catalogEnd).toBeGreaterThan(catalogStart)
    expect(catalogRenderer).toContain('item?.lifecycle === "approved"')
    expect(catalogRenderer).toContain('item?.visibility === "public"')
    expect(catalogRenderer).toContain('item.code')
    expect(catalogRenderer).toContain('item.kind')
    expect(recharge).toContain('item.priceFen')
    expect(catalogRenderer).not.toMatch(/item\?\.approval_state|item\.(?:sku_code|type|price_label|benefits_summary)/u)
    for (const status of ['已到账', '待支付', '未成功', '已关闭', '已退款']) expect(recharge).toContain(status)
  })


  it('keeps the operator-sensitive platform account list out of the merchant bridge', () => {
    const response = spawnSync(process.execPath, [resolve(root, 'mcp/bridge.mjs')], {
      encoding: 'utf8',
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
      env: {
        ...process.env,
        MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790',
        MERCHANT_WORKSPACE_ID: 'ws_install_verify',
      },
    })
    expect(response.status).toBe(0)
    const listed = JSON.parse(response.stdout.trim())
    const tool = listed.result.tools.find((item: { name: string }) => item.name === 'platform.store.list')
    expect(tool).toBeUndefined()
  })

  it('documents content-first onboarding without treating unbound candidates as exportable versions', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const firstStep = readme.indexOf('## 安装后第一步')
    expect(firstStep).toBeGreaterThanOrEqual(0)
    const firstStepSection = readme.slice(firstStep, readme.indexOf('\n## ', firstStep + 3) < 0 ? undefined : readme.indexOf('\n## ', firstStep + 3))
    expect(firstStepSection).toContain('公开商品链接')
    expect(firstStepSection).toContain('draft_only="true"')
    expect(firstStepSection).toContain('content.draft.generate')
    expect(firstStepSection).toContain('content.export')
    expect(firstStepSection).toContain('formalVersionCreated=false')
    expect(firstStepSection).toContain('不能宣称候选审核与文件导出已闭环')
    expect(firstStepSection).not.toContain('platform.connect')
  })

  it('keeps image generation on the business relay instead of the host image tool', () => {
    const skill = readFileSync(resolve(root, 'skills/merchant-marketing/SKILL.md'), 'utf8')
    expect(skill).toContain('统一使用 `catalog.image.generate` 的服务端适配器')
    expect(skill).toContain('不得调用宿主原生 `image_gen` 绕过业务 relay')
  })

  it('routes product video planning through confirmed facts and keeps rendering fail-closed', () => {
    const skill = readFileSync(resolve(root, 'skills/merchant-marketing/SKILL.md'), 'utf8')
    expect(skill).toContain('ecommerce-video-marketing')
    expect(skill).toContain('storyboard-prompt-assistant')
    expect(skill).toContain('读取商品事实与素材扫描结果')
    expect(skill).toContain('用 `creative.brief` 形成结构化视频 brief')
    expect(skill).toContain('调用 `multimodal.video.request` 的 `output=rendering`')
    expect(skill).toContain('查询同一 provider job')
    expect(skill).toContain('对象归档、病毒扫描和商品保真复核')
    expect(skill).toContain('不能用脚本、分镜或 fixture 视频冒充可发布商品视频')
    expect(skill).toContain('不调用宿主视频工具、不自行选择 provider')
    expect(skill).toContain('开头 3 秒内应出现明确商品或问题场景')
    expect(skill).toContain('按静音观看设计关键卖点、字幕和 CTA')
    expect(skill).toContain('以实际音频时长校准镜头时间')
    expect(skill).toContain('读取服务端平台媒体规格')
  })

  it('keeps the MCP startup contract marketplace mirror aligned', () => {
    const marketplaceRoot = resolve(process.cwd(), '.codex-marketplace/plugins/merchant-marketing')
    expect(readFileSync(resolve(root, '.mcp.json'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, '.mcp.json'), 'utf8'))
    expect(readFileSync(resolve(root, 'mcp/bridge.sh'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, 'mcp/bridge.sh'), 'utf8'))
    expect(readFileSync(resolve(root, 'package.json'), 'utf8')).toBe(readFileSync(resolve(marketplaceRoot, 'package.json'), 'utf8'))
  })

  it('verifies installed runtime files and the commercial recovery tool surface without claiming conversation refresh', () => {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/verify-installed-bridge.mjs'), '--source', root, '--installed', root], {
      encoding: 'utf8',
      env: { ...process.env, MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' },
    })
    expect(result.status).toBe(0)
    const evidence = JSON.parse(result.stdout)
    expect(evidence).toMatchObject({
      ok: true,
      plugin_version: readJson('.codex-plugin/plugin.json').version,
      tools: {
        required: ['merchant.start', 'commercial.access.get', 'commercial.catalog.get', 'creative-points.balance.get', 'creative-points.statement.list'],
        missing: [],
        forbidden: [],
      },
      current_conversation_refresh: { verified: false },
    })
    expect(evidence.tools.count).toBeGreaterThanOrEqual(5)
    expect(evidence.runtime_files.every((file: { matches: boolean }) => file.matches)).toBe(true)
  })
})
