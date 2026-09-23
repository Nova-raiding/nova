import { describe, expect, it } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  'MERCHANT_MCP_REFRESH_TOKEN',
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
  it('does not replace an unrecognized previous installation', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-install-rollback-'))
    const home = resolve(directory, 'home')
    const source = resolve(directory, '.agents', 'unpacked-plugin')
    const destination = resolve(home, 'plugins/merchant-marketing')
    const cache = resolve(home, '.codex/plugins/cache/merchant-personal/merchant-marketing/local')
    const registry = resolve(home, '.agents/plugins/marketplace.json')
    const config = resolve(home, '.codex/config.toml')
    try {
      mkdirSync(resolve(source, 'scripts'), { recursive: true })
      mkdirSync(resolve(source, 'runtime'))
      mkdirSync(resolve(source, '.codex-plugin'))
      mkdirSync(destination, { recursive: true })
      mkdirSync(cache, { recursive: true })
      mkdirSync(resolve(home, '.agents/plugins'), { recursive: true })
      cpSync(resolve(root, 'scripts/install-chatgpt-bundled.mjs'), resolve(source, 'scripts/install-chatgpt-bundled.mjs'))
      cpSync(resolve(root, 'scripts/bundle-provenance.mjs'), resolve(source, 'scripts/bundle-provenance.mjs'))
      writeFileSync(resolve(source, '.codex-plugin/plugin.json'), JSON.stringify({ id: 'merchant-marketing', name: 'merchant-marketing', version: '1.0.0', mcpServers: './.mcp.json' }))
      writeFileSync(resolve(source, 'package.json'), JSON.stringify({ name: '@merchant-marketing/plugin', version: '1.0.0' }))
      writeFileSync(resolve(source, 'runtime/node'), 'bundled runtime marker')
      const bundlePaths = ['.codex-plugin/plugin.json', 'package.json', 'runtime/node', 'scripts/bundle-provenance.mjs', 'scripts/install-chatgpt-bundled.mjs']
      writeFileSync(resolve(source, 'bundle-provenance.json'), `${JSON.stringify({
        schema_version: '1', plugin: 'merchant-marketing', version: '1.0.0', platform: process.platform,
        architecture: process.arch, git_commit: 'a'.repeat(40), source_dirty: false, authenticity_verified: false,
        files: bundlePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(resolve(source, path))).digest('hex') })),
      })}\n`)
      writeFileSync(resolve(destination, 'previous.txt'), 'installed before update')
      writeFileSync(resolve(cache, 'previous.txt'), 'cached before update')
      const oldRegistry = JSON.stringify({ name: 'merchant-personal', plugins: [{ name: 'another-plugin' }] })
      const oldConfig = '[other]\nenabled = true\n'
      writeFileSync(registry, oldRegistry)
      writeFileSync(config, oldConfig)
      const result = spawnSync(process.execPath, [resolve(source, 'scripts/install-chatgpt-bundled.mjs')], {
        encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: resolve(home, '.codex'), AGENTS_HOME: resolve(home, '.agents') },
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not recognized as Store Nova')
      expect(readFileSync(resolve(destination, 'previous.txt'), 'utf8')).toBe('installed before update')
      expect(readFileSync(resolve(cache, 'previous.txt'), 'utf8')).toBe('cached before update')
      expect(readFileSync(registry, 'utf8')).toBe(oldRegistry)
      expect(readFileSync(config, 'utf8')).toBe(oldConfig)
      expect(readdirSync(resolve(home, 'plugins')).some(name => name.includes('previous-') || name.includes('install-'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')('packages a standalone macOS runtime and credential helper without shipping an unsigned custom-scheme app', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-local-package-'))
    const artifact = resolve(directory, 'merchant-marketing.tar.gz')
    try {
      const packaged = spawnSync(process.execPath, [resolve(root, 'scripts/package-local-plugin.mjs'), artifact], { encoding: 'utf8' })
      expect(packaged.status, packaged.stderr).toBe(0)
      const packageMetadata = JSON.parse(packaged.stdout)
      expect(packageMetadata).toMatchObject({
        ok: true,
        platform: 'darwin',
        architecture: process.arch,
        bundled_node_version: 'v22.16.0',
        ready_to_install: false,
        connect_helper: {
          source_included: true,
          app_bundle_included: false,
          custom_scheme: 'development_recovery_only',
          production_ready: false,
          platforms: {
            darwin: { source_included: true, binary_included: false },
            win32: { source_included: true, binary_included: false, authenticode_required: true },
          },
        },
      })
      expect(packageMetadata.release_status).toBe(packageMetadata.source_dirty ? 'dirty_source_candidate' : 'unsigned_candidate')
      const listing = spawnSync('tar', ['-tzf', artifact], { encoding: 'utf8' })
      expect(listing.status, listing.stderr).toBe(0)
      const skillFiles: string[] = []
      const collectSkillFiles = (directoryPath: string, relative = ''): void => {
        for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
          const nested = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDirectory()) collectSkillFiles(resolve(directoryPath, entry.name), nested)
          else if (entry.isFile() && !/\.test\.[cm]?[jt]s$/u.test(entry.name)) skillFiles.push(`skills/${nested}`)
        }
      }
      collectSkillFiles(resolve(root, 'skills'))
      for (const skillFile of skillFiles) expect(listing.stdout).toContain(skillFile)
      expect(listing.stdout).not.toContain('skills/six-platform-public-import/scripts/extract-product.test.mjs')
      expect(listing.stdout).toContain('macos/store-nova-connect-helper.swift')
      expect(listing.stdout).toContain('scripts/build-connect-helper.mjs')
      expect(listing.stdout).toContain('scripts/connect-local-macos.mjs')
      expect(listing.stdout).toContain('windows/StoreNovaConnectHelper.cs')
      expect(listing.stdout).toContain('scripts/build-connect-helper-windows.mjs')
      expect(listing.stdout).toContain('scripts/verify-connect-helper-windows.ps1')
      expect(listing.stdout).toContain('install-chatgpt.ps1')
      expect(listing.stdout).toContain('runtime/node')
      expect(listing.stdout).toContain('install-all.command')
      expect(listing.stdout).toContain('scripts/install-all-macos.mjs')
      expect(listing.stdout).toContain('scripts/verify-chatgpt-macos.mjs')
      expect(listing.stdout).not.toContain('ChatGPT.app')
      expect(listing.stdout).toContain('bundle-provenance.json')
      const macInstaller = spawnSync('tar', ['-xOf', artifact, 'install.command'], { encoding: 'utf8' })
      expect(macInstaller.status, macInstaller.stderr).toBe(0)
      writeFileSync(resolve(directory, 'install.command'), macInstaller.stdout)
      writeFileSync(resolve(directory, 'install.sh'), '#!/bin/sh\nexit 0\n')
      writeFileSync(resolve(directory, 'login.sh'), '#!/bin/sh\nexit 0\n')
      const pendingWorkspace = spawnSync('/bin/sh', [resolve(directory, 'install.command')], { input: '\n', encoding: 'utf8' })
      expect(pendingWorkspace.status).toBe(42)
      expect(pendingWorkspace.stdout).toContain('工作区绑定未完成')
      expect(listing.stdout).toContain('scripts/bundle-provenance.mjs')
      expect(listing.stdout).toContain('scripts/verify-bundle-provenance.mjs')
      expect(listing.stdout).toContain('mcp/keychain-credential-helper.build.json')
      expect(listing.stdout).toContain('mcp/keychain-credential-helper')
      expect(listing.stdout).toContain('scripts/install-chatgpt-bundled.mjs')
      const extractedHelper = spawnSync('tar', ['-xzf', artifact, '-C', directory, 'mcp/keychain-credential-helper'], { encoding: 'utf8' })
      expect(extractedHelper.status, extractedHelper.stderr).toBe(0)
      const buildVersion = spawnSync('vtool', ['-show-build', resolve(directory, 'mcp/keychain-credential-helper')], { encoding: 'utf8' })
      expect(buildVersion.status, buildVersion.stderr).toBe(0)
      expect(buildVersion.stdout).toMatch(/minos 11\.0/u)
      const packagedMcp = spawnSync('tar', ['-xOzf', artifact, '.mcp.json'], { encoding: 'utf8' })
      expect(JSON.parse(packagedMcp.stdout).mcpServers['merchant-marketing'].command).toBe('./runtime/node')
      const installer = spawnSync('tar', ['-xOzf', artifact, 'install-plugin.ps1'], { encoding: 'utf8' })
      expect(installer.status, installer.stderr).toBe(0)
      const entry = spawnSync('tar', ['-xOzf', artifact, 'install-chatgpt.ps1'], { encoding: 'utf8' })
      expect(entry.status, entry.stderr).toBe(0)
      expect(entry.stdout.indexOf('ensure-chatgpt-windows.ps1')).toBeLessThan(entry.stdout.indexOf('install-plugin.ps1'))
      expect(listing.stdout).toContain('scripts/ensure-chatgpt-windows.ps1')
      expect(installer.stdout).toContain('login.cmd --workspace')
      expect(installer.stdout).not.toContain('SetEnvironmentVariable("MERCHANT_WORKSPACE_ID"')
      expect(installer.stdout).not.toContain('ws_guirenniaoniao')
      expect(installer.stdout).toContain('StoreNovaCredentialHelper.exe')
      expect(installer.stdout).toContain('Get-FileHash')
      expect(installer.stdout).toContain('Get-AuthenticodeSignature')
      expect(installer.stdout).toContain('credential-signer.txt')
      expect(installer.stdout.indexOf('Get-AuthenticodeSignature')).toBeLessThan(installer.stdout.indexOf('install-chatgpt-bundled.mjs'))
      expect(installer.stdout).toContain('install-chatgpt-bundled.mjs')
      expect(installer.stdout).toContain('runtime\\node.exe')
      expect(listing.stdout).not.toContain('StoreNovaCredentialHelper.exe')
      expect(listing.stdout).not.toMatch(/ChatGPT.*\.msix|ChatGPT-License\.xml/iu)
      expect(listing.stdout).not.toContain('Store Nova Connect.app')
      expect(listing.stdout).not.toContain('StoreNovaConnectHelper.exe')
      const extracted = resolve(directory, 'extracted')
      const home = resolve(directory, 'clean-home')
      mkdirSync(extracted)
      mkdirSync(home)
      expect(spawnSync('tar', ['-xzf', artifact, '-C', extracted]).status).toBe(0)
      const installed = spawnSync('/bin/sh', [resolve(extracted, 'install.sh')], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home,
          CODEX_HOME: resolve(home, '.codex'), AGENTS_HOME: resolve(home, '.agents') },
      })
      expect(installed.status, installed.stderr).toBe(0)
      const installedRoot = resolve(home, 'plugins/merchant-marketing')
      expect(existsSync(resolve(installedRoot, 'runtime/node'))).toBe(true)
      expect(existsSync(resolve(installedRoot, '.agents'))).toBe(false)
      expect(JSON.parse(readFileSync(resolve(home, '.agents/plugins/marketplace.json'), 'utf8')).plugins[0].source.path).toBe('./plugins/merchant-marketing')
      const installedCache = resolve(home, '.codex/plugins/cache/merchant-personal/merchant-marketing/local')
      expect(existsSync(resolve(installedCache, 'runtime/node'))).toBe(true)
      expect(existsSync(resolve(installedCache, '.agents'))).toBe(false)
      expect(readFileSync(resolve(home, '.codex/config.toml'), 'utf8')).toContain('[plugins."merchant-marketing@merchant-personal"]\nenabled = true')
      const bundledNode = spawnSync(resolve(installedRoot, 'runtime/node'), ['-p', 'process.versions.node'],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } })
      expect(bundledNode.status, bundledNode.stderr).toBe(0)
      expect(bundledNode.stdout.trim()).toBe('22.16.0')
      const mcp = spawnSync(resolve(installedRoot, 'runtime/node'), [resolve(installedRoot, 'mcp/bridge.mjs')], {
        cwd: installedRoot,
        encoding: 'utf8',
        input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
        env: { PATH: '/usr/bin:/bin', HOME: home, NODE_ENV: 'test', DEPLOY_ENV: 'local_desktop' },
        timeout: 15_000,
      })
      expect(mcp.status, mcp.stderr).toBe(0)
      const responses = mcp.stdout.trim().split('\n').map(line => JSON.parse(line))
      expect(responses[0].result.serverInfo.version).toBe(readJson('.codex-plugin/plugin.json').version)
      expect(responses[1].result.tools.length).toBeGreaterThan(0)
      const tamperedHome = resolve(directory, 'tampered-home')
      mkdirSync(tamperedHome)
      writeFileSync(resolve(extracted, 'mcp/bridge.mjs'), `${readFileSync(resolve(extracted, 'mcp/bridge.mjs'), 'utf8')}\n`)
      const rejected = spawnSync('/bin/sh', [resolve(extracted, 'install.sh')], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tamperedHome,
          CODEX_HOME: resolve(tamperedHome, '.codex'), AGENTS_HOME: resolve(tamperedHome, '.agents') },
      })
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain('file digest differs: mcp/bridge.mjs')
      expect(existsSync(resolve(tamperedHome, '.agents/plugins/marketplace.json'))).toBe(false)
      expect(existsSync(resolve(tamperedHome, '.codex/config.toml'))).toBe(false)
      expect(existsSync(resolve(tamperedHome, 'plugins/merchant-marketing'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('does not bundle a Windows credential binary without a Windows signing check', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-windows-package-'))
    try {
      const artifact = resolve(directory, 'merchant-marketing.tar.gz')
      const packaged = spawnSync(process.execPath, [resolve(root, 'scripts/package-local-plugin.mjs'), artifact, '--windows-helper-dir', directory], { encoding: 'utf8' })
      expect(packaged.status).not.toBe(0)
      expect(packaged.stderr).toMatch(/signed Windows helper packaging must run on Windows|trusted Windows signer thumbprint is required|signed Windows credential helper and SHA-256 file are both required/u)
      expect(existsSync(artifact)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

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
      supportedDesktopPlatforms: ['darwin', 'win32'],
      environmentRecovery: 'host-injected environment with platform credential storage',
    })
    const server = mcp.mcpServers['merchant-marketing']
    expect(server).toMatchObject({
      command: 'node',
      args: ['./mcp/bridge.mjs'],
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
  }, 15_000)

  it('installs and verifies the plugin from a local checkout without public marketplace or ChatGPT OAuth', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-direct-local-install-'))
    const bin = resolve(directory, 'bin')
    const fakeCodex = resolve(bin, 'codex')
    const commandLog = resolve(directory, 'commands.log')
    const localSource = resolve(directory, 'local-source')
    const installed = resolve(directory, 'installed')
    mkdirSync(bin)
    mkdirSync(localSource)
    cpSync(root, installed, { recursive: true })
    writeFileSync(resolve(localSource, 'marketplace.json'), JSON.stringify({
      name: 'merchant-local-test',
      plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: root } }],
    }))
    writeFileSync(fakeCodex, `#!/bin/sh
printf '%s\\n' "$*" >> '${commandLog}'
case "$*" in
  'plugin marketplace list') printf 'MARKETPLACE ROOT\\n' ;;
  'plugin marketplace add '*' --json') printf '{"ok":true}\\n' ;;
  'plugin add merchant-marketing@merchant-local-test --json') printf '{"ok":true}\\n' ;;
  *) exit 2 ;;
esac
`)
    chmodSync(fakeCodex, 0o755)
    try {
      const result = spawnSync(process.execPath, [
        resolve(root, 'scripts/install-local-plugin.mjs'),
        '--source', root,
        '--local-source', localSource,
        '--codex', fakeCodex,
        '--installed', installed,
      ], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        mode: 'local_stdio',
        public_marketplace_required: false,
        chatgpt_oauth_required: false,
        plugin: 'merchant-marketing',
        restart_required: true,
      })
      const commands = readFileSync(commandLog, 'utf8')
      expect(commands).toContain(`plugin marketplace add ${localSource} --json`)
      expect(commands).toContain('plugin add merchant-marketing@merchant-local-test --json')
      expect(commands).not.toMatch(/https?:\/\//u)
      expect(commands).not.toMatch(/oauth/iu)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers local merchant settings from the macOS user session without exposing them in the manifest', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-launchctl-'))
    const launchctl = resolve(directory, 'launchctl')
    const uname = resolve(directory, 'uname')
    const node = resolve(directory, 'node-probe')
    writeFileSync(launchctl, `#!/bin/sh\ncase "$2" in\n  MERCHANT_MCP_BASE_URL) printf '%s' 'http://127.0.0.1:8790' ;;\n  MERCHANT_WORKSPACE_ID) printf '%s' 'ws_demo' ;;\n  MERCHANT_MCP_TOKEN) printf '%s' 'test-token' ;;\n  MERCHANT_MCP_REFRESH_TOKEN) printf '%s' 'test-refresh-token' ;;\n  MERCHANT_STRICT_AUTH) printf '%s' 'true' ;;\n  MERCHANT_ALLOW_FIXTURE_FALLBACK) printf '%s' 'true' ;;\n  MERCHANT_MCP_WRITE_ENABLED) printf '%s' 'false' ;;\n  MERCHANT_ASSET_RESOURCE_DOMAINS) printf '%s' 'https://assets.example.test' ;;\nesac\n`)
    writeFileSync(uname, `#!/bin/sh\nprintf '%s\n' Darwin\n`)
    writeFileSync(node, `#!/bin/sh\ncase "\${1:-}" in\n  -e) exit 0 ;;\n  -p) printf '%s' '22.0.0'; exit 0 ;;\nesac\nprintf '%s|%s|%s|%s|%s|%s|%s|%s' "$MERCHANT_MCP_BASE_URL" "$MERCHANT_WORKSPACE_ID" "$MERCHANT_MCP_TOKEN" "$MERCHANT_MCP_REFRESH_TOKEN" "$MERCHANT_STRICT_AUTH" "$MERCHANT_ALLOW_FIXTURE_FALLBACK" "$MERCHANT_MCP_WRITE_ENABLED" "$MERCHANT_ASSET_RESOURCE_DOMAINS"\n`)
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
          MERCHANT_MCP_REFRESH_TOKEN: '${MERCHANT_MCP_REFRESH_TOKEN}',
          MERCHANT_STRICT_AUTH: '${MERCHANT_STRICT_AUTH}',
        },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('http://127.0.0.1:8790|ws_demo|host-token|test-refresh-token|true|true|false|https://assets.example.test')
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
    expect(recharge).toContain('支付成功也必须等待 grant 到账和新 access revision')
    expect(recharge).not.toContain('call("billing.recharge.create"')
    expect(recharge).not.toMatch(/data-amount|customAmount|createOrder/u)
    expect(recharge).toContain('服务端授权的恢复入口')
    expect(recharge).toContain('余额状态待确认时会保持“待确认”')
    expect(recharge).not.toContain('balance_state=unknown')
    expect(recharge).not.toContain('unknown: "未知"')
    expect(recharge).toContain('call("billing.recharge.list"')
    expect(recharge).toContain('支付统一在 Store Nova 商家后台完成')
    expect(recharge).toContain('打开商家后台')
    expect(recharge).toContain('https://yxsona.com')
    expect(recharge).not.toContain('打开支付入口')
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
    for (const status of ['已到账', '待支付', '未成功', '已关闭', '已退款']) expect(recharge).toContain(status)
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
    // The merchant bridge does not expose the video rendering tool by default.
    // The entry skill must gate the call on the current tools/list surface
    // instead of instructing an unconditional call that returns Unknown tool.
    expect(skill).toContain('只有当前 `tools/list` 实际暴露视频渲染工具时')
    expect(skill).toContain('以 `output=rendering` 调用它')
    expect(skill).not.toContain('调用 `multimodal.video.request`')
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

  it('provides a redacted macOS local installer that hands off a short-lived token through launchd', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-local-installer-'))
    const bin = resolve(directory, 'bin')
    const state = resolve(directory, 'launchd-state')
    const codexHome = resolve(directory, 'codex-home')
    const bindingDirectory = resolve(codexHome, 'merchant-marketing')
    const binding = resolve(bindingDirectory, 'workspace-binding.json')
    mkdirSync(bin)
    mkdirSync(bindingDirectory, { recursive: true })
    writeFileSync(binding, JSON.stringify({
      schema_version: '2',
      workspace_id: 'ws_install',
      scope: { api_origin: 'http://127.0.0.1:8787', actor_id: '', token_sha256: '', environment: 'development' },
    }))
    writeFileSync(resolve(bin, 'uname'), '#!/bin/sh\nprintf Darwin\n')
    writeFileSync(resolve(bin, 'launchctl'), `#!/bin/sh
set -eu
state='${state}'
case "\${1:-}" in
  setenv) printf '%s=%s\\n' "\$2" "\$3" >> "\$state" ;;
  getenv) key="\$2"; awk -F= -v key="\$key" '\$1 == key { value=substr(\$0, index(\$0,"=")+1) } END { printf "%s", value }' "\$state" 2>/dev/null || true ;;
  *) exit 2 ;;
esac
`)
    chmodSync(resolve(bin, 'uname'), 0o755)
    chmodSync(resolve(bin, 'launchctl'), 0o755)
    try {
      const token = 'short-lived-token-not-printed'
      const refreshToken = 'rotating-refresh-token-not-printed'
      const bindingBeforeInstall = readFileSync(binding, 'utf8')
      const result = spawnSync('sh', [resolve(root, 'scripts/install-local-macos.sh'), '--base-url', 'https://yxsona.com', '--workspace', 'ws_install'], {
        input: `${token}\n${refreshToken}\n`, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CODEX_HOME: codexHome, CODEX_NODE_BIN: process.execPath },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain(token)
      expect(result.stderr).not.toContain(token)
      expect(result.stdout).not.toContain(refreshToken)
      expect(result.stderr).not.toContain(refreshToken)
      expect(result.stderr).toContain('检测到陈旧的 workspace binding')
      expect(result.stderr).toContain('binding origin 已从本机 loopback 变为 https://yxsona.com')
      expect(result.stderr).toContain('旧 binding 缺少完整身份指纹')
      expect(readFileSync(binding, 'utf8')).toBe(bindingBeforeInstall)
      const values = readFileSync(state, 'utf8')
      expect(values).toContain('MERCHANT_MCP_BASE_URL=https://yxsona.com')
      expect(values).toContain('MERCHANT_WORKSPACE_ID=ws_install')
      expect(values).toContain(`MERCHANT_MCP_TOKEN=${token}`)
      expect(values).toContain(`MERCHANT_MCP_REFRESH_TOKEN=${refreshToken}`)
      expect(values).toContain('MERCHANT_MCP_TOKEN_SOURCE=launchd')
      expect(values).toContain('MERCHANT_STRICT_AUTH=true')
      expect(values).toContain('MERCHANT_ALLOW_FIXTURE_FALLBACK=false')
      expect(values).toContain('MERCHANT_MCP_WRITE_ENABLED=false')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('diagnoses a loopback binding migration without reusing or deleting the old identity', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-binding-diagnostic-'))
    const binding = resolve(directory, 'workspace-binding.json')
    writeFileSync(binding, JSON.stringify({
      schema_version: '2',
      workspace_id: 'ws_install',
      scope: { api_origin: 'http://127.0.0.1:8787', actor_id: '', token_sha256: '', environment: 'development' },
    }))
    try {
      const before = readFileSync(binding, 'utf8')
      const result = spawnSync(process.execPath, [
        resolve(root, 'scripts/diagnose-workspace-binding.mjs'),
        '--binding', binding,
        '--target-origin', 'https://yxsona.com',
        '--workspace', 'ws_install',
      ], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        stale: true,
        reusable: false,
        reasons: ['loopback_to_production_origin', 'identity_fingerprint_missing'],
        safety: { old_identity_reused: false, binding_deleted: false, secrets_read: false },
      })
      expect(readFileSync(binding, 'utf8')).toBe(before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports missing identity fingerprints even when origin and workspace match', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-binding-fingerprint-'))
    const binding = resolve(directory, 'workspace-binding.json')
    writeFileSync(binding, JSON.stringify({
      schema_version: '2',
      workspace_id: 'ws_install',
      scope: { api_origin: 'https://yxsona.com', actor_id: '', token_sha256: '', environment: 'local_desktop' },
    }))
    try {
      const result = spawnSync(process.execPath, [
        resolve(root, 'scripts/diagnose-workspace-binding.mjs'),
        '--binding', binding,
        '--target-origin', 'https://yxsona.com',
        '--workspace', 'ws_install',
      ], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        stale: true,
        reusable: false,
        reasons: ['identity_fingerprint_missing'],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
      manifest: { errors: [] },
      tools: {
        required: ['merchant.start', 'commercial.access.get', 'commercial.catalog.get', 'creative-points.balance.get', 'creative-points.statement.list'],
        missing: [],
        forbidden: [],
        cache_drift: { detected: false, automatic_reuse: false, automatic_deletion: false },
      },
      current_conversation_refresh: { verified: false },
      connect_helper: {
        source_verified: true,
        app_bundle_verified: false,
        custom_scheme: 'development_recovery_only',
        production_ready: false,
        platforms: {
          darwin: { source_verified: true, signed_bundle_verified: false, production_ready: false },
          win32: { source_verified: true, sha256_verified: false, authenticode_verified: false, production_ready: false },
        },
      },
    })
    expect(evidence.tools.count).toBeGreaterThanOrEqual(5)
    expect(evidence.runtime_files.every((file: { matches: boolean }) => file.matches)).toBe(true)
  })

  it('keeps Windows helper installation fail-closed behind hash, Authenticode, signer, and instance binding gates', () => {
    const build = readFileSync(resolve(root, 'scripts/build-connect-helper-windows.mjs'), 'utf8')
    const verify = readFileSync(resolve(root, 'scripts/verify-connect-helper-windows.ps1'), 'utf8')
    const helper = readFileSync(resolve(root, 'windows/StoreNovaConnectHelper.cs'), 'utf8')
    expect(build).toContain("process.platform !== 'win32'")
    expect(build).toContain('signed: false, production_ready: false')
    expect(verify).toContain('Get-FileHash')
    expect(verify).toContain('Get-AuthenticodeSignature')
    expect(verify).toContain('STORENOVA_WINDOWS_SIGNER_THUMBPRINT')
    expect(verify).toContain("protocol_registered = $false")
    expect(verify).toContain("installed = $false")
    expect(verify).toContain("production_ready = $false")
    expect(verify).toContain("blocker = 'installation_instance_binding_missing'")
    expect(verify).toContain('exit 78')
    expect(verify).not.toMatch(/New-ItemProperty|HKCU:|HKLM:|CredentialManager/iu)
    expect(helper).toContain('STORE_NOVA_CONNECT_WINDOWS_NOT_PRODUCTION_READY')
    expect(helper).not.toMatch(/Microsoft\.Win32|CredentialManager/iu)
  })

  it('uses the official Store identity before the Windows plugin-only installer', () => {
    const preflight = readFileSync(resolve(root, 'scripts/ensure-chatgpt-windows.ps1'), 'utf8')
    const packager = readFileSync(resolve(root, 'scripts/package-local-plugin.mjs'), 'utf8')
    expect(preflight).toContain("$packageName = 'OpenAI.Codex'")
    expect(preflight).toContain("$storeId = '9PLM9XGG6VKS'")
    expect(preflight).toContain("$publisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'")
    expect(preflight).toContain("$package.SignatureKind.ToString() -ne 'Store'")
    expect(preflight).toContain('CHATGPT_APP_REQUIRED')
    expect(preflight).not.toMatch(/Add-AppxPackage|Add-AppxProvisionedPackage|ChatGPT-x64\.msix/iu)
    expect(packager.indexOf('ensure-chatgpt-windows.ps1')).toBeLessThan(packager.indexOf('install-plugin.ps1'))
  })

  it.each([
    'scripts/connect-local-macos.mjs',
    'windows/StoreNovaConnectHelper.cs',
  ])('fails upgrade verification when installed connection helper source %s is stale', helperRelativePath => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-connect-helper-drift-'))
    const installed = resolve(directory, 'installed')
    try {
      cpSync(root, installed, { recursive: true })
      const helperPath = resolve(installed, helperRelativePath)
      writeFileSync(helperPath, `${readFileSync(helperPath, 'utf8')}\n// stale installed helper\n`)
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/verify-installed-bridge.mjs'), '--source', root, '--installed', installed], {
        encoding: 'utf8',
        env: { ...process.env, MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' },
      })
      expect(result.status).toBe(1)
      const evidence = JSON.parse(result.stdout)
      expect(evidence.connect_helper).toMatchObject({ source_verified: false, production_ready: false })
      expect(evidence.runtime_files).toContainEqual(expect.objectContaining({ path: helperRelativePath, matches: false }))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('classifies an installed tool-surface mismatch as cache drift without deleting or reusing it', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-tool-cache-drift-'))
    const installed = resolve(directory, 'installed')
    try {
      cpSync(root, installed, { recursive: true })
      const bridgePath = resolve(installed, 'mcp/bridge.mjs')
      const bridge = readFileSync(bridgePath, 'utf8')
      expect(bridge).toContain("'merchant.start'")
      writeFileSync(bridgePath, bridge.replace("'merchant.start'", "'merchant.start.stale'"))
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/verify-installed-bridge.mjs'), '--source', root, '--installed', installed], {
        encoding: 'utf8',
        env: { ...process.env, MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' },
      })
      expect(result.status).toBe(1)
      const evidence = JSON.parse(result.stdout)
      expect(evidence.tools.cache_drift).toMatchObject({
        detected: true,
        automatic_reuse: false,
        automatic_deletion: false,
      })
      expect(evidence.runtime_files).toContainEqual(expect.objectContaining({ path: 'mcp/bridge.mjs', matches: false }))
      expect(existsSync(installed)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
