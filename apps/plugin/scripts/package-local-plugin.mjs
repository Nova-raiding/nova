#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(pluginRoot, '..', '..')
const manifest = JSON.parse(readFileSync(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
if (!version || version !== String(packageJson.version ?? '')) {
  throw new Error('plugin manifest and package versions must match before packaging')
}

const output = resolve(process.argv[2] ?? resolve(repositoryRoot, 'artifacts', 'local-plugin', `${manifest.id}-${version}.tar.gz`))
const required = [
  '.codex-plugin/plugin.json', '.mcp.json', 'package.json', 'README.md',
  'mcp/bridge.mjs', 'mcp/bridge.sh', 'mcp/keychain-credential.mjs', 'mcp/keychain-credential-helper.swift',
  'mcp/managed-token.mjs', 'mcp/relay-evidence.mjs', 'mcp/installation-identity.mjs', 'mcp/windows-credential.mjs',
  'macos/store-nova-connect-helper.swift',
  'scripts/build-connect-helper.mjs', 'scripts/connect-local-macos.mjs',
  'windows/StoreNovaConnectHelper.cs', 'windows/StoreNovaCredentialHelper.cs', 'windows/StoreNovaCredentialHelper.csproj',
  'scripts/build-connect-helper-windows.mjs', 'scripts/build-windows-credential-helper.mjs', 'scripts/verify-connect-helper-windows.ps1',
  'scripts/build-keychain-helper.mjs', 'scripts/diagnose-workspace-binding.mjs', 'scripts/install-local-macos.sh',
  'scripts/install-local-plugin.mjs', 'scripts/login-local-macos.mjs', 'scripts/login-local-windows.mjs', 'scripts/upgrade-installed-plugin.mjs',
  'scripts/verify-installed-bridge.mjs', 'scripts/verify-marketplace-source.mjs',
  'scheduled/daily-store-risk-scan.json', 'scheduled/weekly-six-platform-digest.json',
  'skills/ecommerce-video-marketing/SKILL.md', 'skills/merchant-marketing/SKILL.md',
  'skills/six-platform-public-import/SKILL.md', 'skills/storyboard-prompt-assistant/SKILL.md',
  'ui/image-local-edit.html', 'ui/recharge.html',
]
for (const relativePath of required) {
  if (!existsSync(resolve(pluginRoot, relativePath))) throw new Error(`local plugin input is missing: ${relativePath}`)
}

const staging = mkdtempSync(resolve(repositoryRoot, '.local-plugin-package-'))
try {
  for (const relativePath of required) {
    const destination = resolve(staging, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(resolve(pluginRoot, relativePath), destination, { recursive: true })
  }
  writeFileSync(resolve(staging, 'marketplace.json'), `${JSON.stringify({ name: 'merchant-local', interface: { displayName: 'Merchant Local' }, plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: './plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2)}\n`)
  const installer = `#!/bin/sh\nset -eu\nroot=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)\ncommand -v codex >/dev/null 2>&1 || { echo 'codex CLI is required' >&2; exit 2; }\ncommand -v node >/dev/null 2>&1 || { echo 'Node.js 18+ is required' >&2; exit 2; }\nversion=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$root/.codex-plugin/plugin.json")\nlocal_root="\${CODEX_HOME:-\$HOME/.codex}/merchant-local-packages/merchant-marketing/\$version"\nmkdir -p "$local_root/plugin"\ncp -R "$root/." "$local_root/plugin/"\nprintf '%s\\n' '{"name":"merchant-local","interface":{"displayName":"Merchant Local"},"plugins":[{"name":"merchant-marketing","source":{"source":"local","path":"./plugin"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]}' > "$local_root/marketplace.json"\ncodex plugin marketplace add "$local_root" --json >/dev/null 2>&1 || true\ncodex plugin add "merchant-marketing@merchant-local" --json\nprintf '%s\\n' "Store Nova installed: version=$version. Restart ChatGPT/Codex to load the local stdio plugin."\n`
  writeFileSync(resolve(staging, 'install.sh'), installer)
  chmodSync(resolve(staging, 'install.sh'), 0o755)
  const packageEntries = [...required, 'marketplace.json', 'install.sh']
  mkdirSync(dirname(output), { recursive: true })
  const result = spawnSync('tar', ['-czf', output, '-C', staging, ...packageEntries], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'tar failed while creating local plugin package')
  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: output,
    plugin: manifest.id,
    version,
    cloud_code_included: false,
    connect_helper: {
      source_included: true,
      app_bundle_included: false,
      custom_scheme: 'development_recovery_only',
      production_ready: false,
      reason: 'Custom-scheme helper binaries are not shipped until platform signing and installation-instance binding are enforced.',
      platforms: {
        darwin: { source_included: true, binary_included: false },
        win32: { source_included: true, binary_included: false, authenticode_required: true },
      },
    },
  }, null, 2)}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
