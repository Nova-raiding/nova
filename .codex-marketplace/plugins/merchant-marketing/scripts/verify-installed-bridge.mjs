#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { provenanceFile, verifyBundleProvenance } from './bundle-provenance.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = resolve(scriptDirectory, '..')
const argumentsByName = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) throw new Error(`invalid argument: ${name ?? ''}`)
  argumentsByName.set(name.slice(2), value)
}

const sourceRoot = resolve(argumentsByName.get('source') ?? defaultSourceRoot)
const installedRoot = resolve(argumentsByName.get('installed') ?? process.env.MERCHANT_INSTALLED_PLUGIN_DIR ?? '')
if (!argumentsByName.get('installed') && !process.env.MERCHANT_INSTALLED_PLUGIN_DIR) {
  throw new Error('installed plugin path is required via --installed or MERCHANT_INSTALLED_PLUGIN_DIR')
}
const packagedSource = existsSync(resolve(sourceRoot, provenanceFile))
const packagedInstall = existsSync(resolve(installedRoot, provenanceFile))
const provenance = packagedSource || packagedInstall
  ? verifyBundleProvenance(installedRoot, { installed: installedRoot !== sourceRoot })
  : { ok: true, errors: [], checked_files: 0, verification_scope: 'unpackaged_development_source' }

const semverPattern = /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u
const sourceManifest = JSON.parse(readFileSync(resolve(sourceRoot, '.codex-plugin/plugin.json'), 'utf8'))
const sourcePackageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const expectedVersion = String(argumentsByName.get('expected-version') ?? sourceManifest.version ?? '')
const expectedPackageProfile = argumentsByName.get('expected-package-profile') ?? null
if (expectedPackageProfile && !['production', 'qa-broker'].includes(expectedPackageProfile)) {
  throw new Error('expected package profile must be production or qa-broker')
}
const sourceManifestVersion = String(sourceManifest.version ?? '')
const sourcePackageVersion = String(sourcePackageJson.version ?? '')
const sourceVersionErrors = [
  semverPattern.test(sourceManifestVersion) ? null : 'source manifest version is missing or invalid',
  sourceManifestVersion === sourcePackageVersion ? null : 'source manifest version does not match source package version',
  expectedVersion === sourceManifestVersion ? null : 'expected version does not match source manifest version',
].filter(Boolean)

function readBundleProfile(root) {
  const path = resolve(root, 'bundle-profile.json')
  if (!existsSync(path)) return null
  try {
    const profile = JSON.parse(readFileSync(path, 'utf8'))
    const isProduction = profile?.schema_version === '1' && profile.profile === 'production'
      && profile.qa_only === false && profile.release_eligible === true
      && profile.credential_broker?.path === 'mcp/keychain-broker.mjs'
      && profile.credential_broker?.included === false
      && profile.credential_broker?.authenticated_peer_identity === false
      && profile.credential_broker?.release_eligible === false
    const isQaBroker = profile?.schema_version === '1' && profile.profile === 'qa-broker'
      && profile.qa_only === true && profile.release_eligible === false
      && profile.credential_broker?.path === 'mcp/keychain-broker.mjs'
      && profile.credential_broker?.included === true
      && profile.credential_broker?.authenticated_peer_identity === false
      && profile.credential_broker?.release_eligible === false
    return isProduction || isQaBroker ? profile : { invalid: true }
  } catch {
    return { invalid: true }
  }
}

const sourceBundleProfile = readBundleProfile(sourceRoot)
const installedBundleProfile = readBundleProfile(installedRoot)
const sourcePackageProfile = sourceBundleProfile?.invalid ? null : sourceBundleProfile?.profile ?? null
const installedPackageProfile = installedBundleProfile?.invalid ? null : installedBundleProfile?.profile ?? null
const packageProfileErrors = [
  sourceBundleProfile?.invalid ? 'source bundle profile is invalid' : null,
  installedBundleProfile?.invalid ? 'installed bundle profile is invalid' : null,
  expectedPackageProfile && installedPackageProfile !== expectedPackageProfile
    ? `installed bundle profile does not match expected ${expectedPackageProfile} profile` : null,
  !expectedPackageProfile && (sourceBundleProfile || installedBundleProfile) && sourcePackageProfile !== installedPackageProfile
    ? 'installed bundle profile does not match source bundle profile' : null,
  sourcePackageProfile === 'production' && existsSync(resolve(sourceRoot, 'mcp/keychain-broker.mjs'))
    ? 'production bundle must not contain the credential broker' : null,
  sourcePackageProfile === 'qa-broker' && !existsSync(resolve(sourceRoot, 'mcp/keychain-broker.mjs'))
    ? 'QA bundle is missing its credential broker' : null,
].filter(Boolean)

const fixedRuntimeFiles = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'README.md',
  'package.json',
  ...(sourceBundleProfile ? ['bundle-profile.json'] : []),
  'assets/store-nova-logo.png',
  'mcp/bridge.sh',
  'mcp/bridge.mjs',
  'mcp/relay-evidence.mjs',
  'mcp/managed-token.mjs',
  'mcp/managed-credential-state.mjs',
  'mcp/installation-identity.mjs',
  'mcp/windows-credential.mjs',
  'mcp/windows-installation-binding.mjs',
  'mcp/windows-session-env.mjs',
  'mcp/keychain-credential.mjs',
  'mcp/keychain-credential-helper.swift',
  'macos/store-nova-connect-helper.swift',
  'scripts/build-connect-helper.mjs',
  'scripts/connect-local-macos.mjs',
  'windows/StoreNovaConnectHelper.cs',
  'windows/StoreNovaCredentialHelper.cs',
  'windows/StoreNovaCredentialHelper.csproj',
  'scripts/build-connect-helper-windows.mjs',
  'scripts/build-windows-credential-helper.mjs',
  'scripts/bundle-provenance.mjs',
  'scripts/diagnose-workspace-binding.mjs',
  'scripts/install-all-macos.mjs',
  'scripts/install-chatgpt-bundled.mjs',
  'scripts/install-local-macos.sh',
  'scripts/install-local-plugin.mjs',
  'scripts/local-plugin-package-profile.mjs',
  'scripts/package-local-plugin.mjs',
  'scripts/upgrade-installed-plugin.mjs',
  'scripts/verify-bundle-provenance.mjs',
  'scripts/verify-installed-bridge.mjs',
  'scripts/verify-marketplace-source.mjs',
  'scripts/verify-connect-helper-windows.ps1',
  'scripts/ensure-chatgpt-windows.ps1',
  'scripts/login-local-macos.mjs',
  'scripts/verify-chatgpt-macos.mjs',
  'scripts/launch-verified-chatgpt-macos.mjs',
  'scripts/enroll-local-macos.mjs',
  'scripts/register-connect-helper.mjs',
  'scripts/login-local-windows.mjs',
  'scripts/windows-installation-binding.mjs',
  'scripts/build-keychain-helper.mjs',
  'scheduled/daily-store-risk-scan.json',
  'scheduled/weekly-six-platform-digest.json',
  'ui/image-local-edit.html',
  'ui/recharge.html',
]
const runtimeTreeRoots = ['skills']
const ignoredRuntimeFile = path => /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[^/]+$/u.test(path)
const walkRuntimeTree = (root, directory) => {
  const absolute = resolve(root, directory)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(absolute, entry.name)
    if (entry.isDirectory()) return walkRuntimeTree(root, relative(root, path))
    const normalized = relative(root, path).split('\\').join('/')
    return entry.isFile() && !ignoredRuntimeFile(normalized) ? [normalized] : []
  })
}
const sourceRuntimeFiles = [...new Set([
  ...fixedRuntimeFiles,
  ...(expectedPackageProfile && !sourceBundleProfile ? ['bundle-profile.json'] : []),
  ...(sourcePackageProfile === 'qa-broker' || (!sourceBundleProfile && existsSync(resolve(sourceRoot, 'mcp/keychain-broker.mjs')))
    ? ['mcp/keychain-broker.mjs'] : []),
  ...runtimeTreeRoots.flatMap(directory => walkRuntimeTree(sourceRoot, directory)),
])].sort()
const installedRuntimeFiles = [...new Set([
  ...fixedRuntimeFiles.filter(path => existsSync(resolve(installedRoot, path))),
  ...(!sourceBundleProfile && existsSync(resolve(installedRoot, 'bundle-profile.json')) ? ['bundle-profile.json'] : []),
  ...(existsSync(resolve(installedRoot, 'mcp/keychain-broker.mjs')) ? ['mcp/keychain-broker.mjs'] : []),
  ...runtimeTreeRoots.flatMap(directory => walkRuntimeTree(installedRoot, directory)),
])].sort()
const missingRuntimeFiles = sourceRuntimeFiles.filter(path => !existsSync(resolve(installedRoot, path)))
const unexpectedRuntimeFiles = installedRuntimeFiles.filter(path => !sourceRuntimeFiles.includes(path))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const bundledNodeCommand = process.platform === 'win32' ? './runtime/node.exe' : './runtime/node'
const sourceMcp = JSON.parse(readFileSync(resolve(sourceRoot, '.mcp.json'), 'utf8'))
const installedMcp = JSON.parse(readFileSync(resolve(installedRoot, '.mcp.json'), 'utf8'))
const installedStartup = installedMcp?.mcpServers?.['merchant-marketing']
const bundledNodePath = resolve(installedRoot, bundledNodeCommand)
const bundledNodeExists = existsSync(bundledNodePath) && statSync(bundledNodePath).isFile()
const bundledMcpMatchesSource = (() => {
  if (installedStartup?.command !== bundledNodeCommand || sourceMcp?.mcpServers?.['merchant-marketing']?.command !== 'node') return false
  const normalized = structuredClone(installedMcp)
  normalized.mcpServers['merchant-marketing'].command = 'node'
  return JSON.stringify(normalized) === JSON.stringify(sourceMcp)
})()
const files = sourceRuntimeFiles.filter(path => existsSync(resolve(sourceRoot, path)) && existsSync(resolve(installedRoot, path))).map(path => {
  const sourceSha256 = sha256(resolve(sourceRoot, path))
  const installedSha256 = sha256(resolve(installedRoot, path))
  return { path, source_sha256: sourceSha256, installed_sha256: installedSha256,
    matches: sourceSha256 === installedSha256 || (path === '.mcp.json' && bundledMcpMatchesSource) }
})

const manifest = JSON.parse(readFileSync(resolve(installedRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8'))
const startup = installedStartup
const manifestErrors = [
  manifest.id === 'merchant-marketing' ? null : 'manifest id is not merchant-marketing',
  manifest.name === 'merchant-marketing' ? null : 'manifest name is not merchant-marketing',
  manifest.version === packageJson.version ? null : 'manifest version does not match package version',
  manifest.version === expectedVersion ? null : 'installed version does not match expected source version',
  manifest.mcpServers === './.mcp.json' ? null : 'manifest mcpServers must point to ./.mcp.json',
  ...packageProfileErrors,
  (startup?.command === 'node' || (startup?.command === bundledNodeCommand && bundledNodeExists))
    && Array.isArray(startup?.args) && startup.args.length === 1 && startup.args[0] === './mcp/bridge.mjs'
    ? null : `MCP startup must use node or the present ${bundledNodeCommand} runtime with ./mcp/bridge.mjs`,
].filter(Boolean)
const installedDirectoryVersion = installedRoot.split(/[\\/]/u).at(-1)
const cachePathVersionError = installedDirectoryVersion && semverPattern.test(installedDirectoryVersion) && installedDirectoryVersion !== expectedVersion
  ? `installed cache directory version ${installedDirectoryVersion} does not match expected version ${expectedVersion}`
  : null
if (cachePathVersionError) manifestErrors.push(cachePathVersionError)

const protocolVersion = '2025-06-18'
const initializeRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion, capabilities: {}, clientInfo: { name: 'installed-bridge-verifier', version: '1' },
} }
const initializedNotification = { jsonrpc: '2.0', method: 'notifications/initialized' }
const discoveryEnv = { ...process.env, MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' }
function bridgeResponses(root, nodeBinary, env, request, expectedBridgeVersion) {
  const bridge = spawnSync(nodeBinary, [resolve(root, 'mcp/bridge.mjs')], {
    encoding: 'utf8',
    input: [initializeRequest, initializedNotification, request].map(message => JSON.stringify(message)).join('\n') + '\n',
    env,
    timeout: 10_000,
  })
  if (bridge.status !== 0) return { error: `exit ${bridge.status ?? 'unknown'}${bridge.error ? `: ${bridge.error.message}` : ''}` }
  try {
    const lines = bridge.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    const initialized = lines.find(line => line.id === 1)
    if (initialized?.result?.protocolVersion !== protocolVersion
      || initialized.result.serverInfo?.name !== 'merchant-marketing'
      || initialized.result.serverInfo?.version !== expectedBridgeVersion) {
      return { error: 'invalid initialize response' }
    }
    const response = lines.find(line => line.id === request.id)
    return response ? { response } : { error: `missing ${request.method} response` }
  } catch {
    return { error: `invalid ${request.method} response` }
  }
}
function discoverTools(root, expectedBridgeVersion, nodeBinary = process.execPath) {
  const probe = bridgeResponses(root, nodeBinary, discoveryEnv,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, expectedBridgeVersion)
  if (probe.error) return { names: [], error: probe.error }
  const tools = probe.response?.result?.tools
  if (!Array.isArray(tools)) return { names: [], error: 'invalid tools/list response' }
  return { tools, names: tools.map(tool => tool?.name).filter(name => typeof name === 'string') }
}

// A name-only comparison cannot detect a stale description or input schema.
// Canonicalize object keys and tool order so the digest describes the exposed
// contract rather than incidental object insertion order. Descriptor/schema
// changes still alter the digest and fail closed.
function canonicalSnapshot(value) {
  if (Array.isArray(value)) return value.map(canonicalSnapshot)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalSnapshot(item)]))
  }
  return value
}
function canonicalToolSnapshot(tools) {
  return canonicalSnapshot([...tools].sort((left, right) => String(left?.name ?? '').localeCompare(String(right?.name ?? ''))))
}
function toolSnapshotDigest(tools) {
  return createHash('sha256').update(JSON.stringify(canonicalToolSnapshot(tools)), 'utf8').digest('hex')
}

const sourceDiscovery = discoverTools(sourceRoot, sourceManifestVersion)
const installedDiscovery = discoverTools(installedRoot, String(manifest.version ?? ''),
  startup?.command === bundledNodeCommand && bundledNodeExists ? bundledNodePath : process.execPath)
// VITEST only disables macOS launchd recovery in the bridge; keep NODE_ENV in
// production so this probes the production failure path without host secrets.
const unconfiguredEnv = { ...process.env, NODE_ENV: 'production', VITEST: 'true', MERCHANT_MCP_TOKEN_SOURCE: 'environment',
  MERCHANT_MCP_BASE_URL: '', MERCHANT_MCP_TOKEN: '', MERCHANT_MCP_REFRESH_TOKEN: '',
  MERCHANT_WORKSPACE_ID: '', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false' }
const unconfiguredProbe = bridgeResponses(installedRoot,
  startup?.command === bundledNodeCommand && bundledNodeExists ? bundledNodePath : process.execPath,
  unconfiguredEnv, { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'workspace.health', arguments: {} } }, String(manifest.version ?? ''))
const unconfiguredCode = unconfiguredProbe.response?.result?.structuredContent?.code
const unconfiguredError = unconfiguredProbe.error
  ?? (unconfiguredProbe.response?.result?.isError === true
    && ['MCP_AUTH_REQUIRED', 'MCP_CONFIGURATION_REQUIRED'].includes(unconfiguredCode)
    ? null : `unconfigured tools/call did not fail closed: ${String(unconfiguredCode ?? 'missing code')}`)
const sourceToolNames = sourceDiscovery.names
const toolNames = installedDiscovery.names
const sourceToolSnapshot = Array.isArray(sourceDiscovery.tools) ? sourceDiscovery.tools : []
const installedToolSnapshot = Array.isArray(installedDiscovery.tools) ? installedDiscovery.tools : []
const sourceToolSnapshotSha256 = toolSnapshotDigest(sourceToolSnapshot)
const installedToolSnapshotSha256 = toolSnapshotDigest(installedToolSnapshot)
const toolSnapshotMatches = Boolean(sourceDiscovery.error || installedDiscovery.error)
  ? false
  : JSON.stringify(canonicalToolSnapshot(sourceToolSnapshot)) === JSON.stringify(canonicalToolSnapshot(installedToolSnapshot))
const sourceToolSet = new Set(sourceToolNames)
const installedToolSet = new Set(toolNames)
const missingFromInstalled = sourceToolNames.filter(name => !installedToolSet.has(name))
const unexpectedInInstalled = toolNames.filter(name => !sourceToolSet.has(name))
const duplicateTools = toolNames.filter((name, index) => toolNames.indexOf(name) !== index)
const requiredTools = [
  'merchant.start',
  'commercial.access.get',
  'commercial.catalog.get',
  'creative-points.balance.get',
  'creative-points.statement.list',
]
const forbiddenMerchantTools = new Set([
  'billing.reconciliation', 'billing.model-usage.reconciliation.run', 'billing.model-usage.resolve',
  'billing.usage.consume', 'billing.usage.refund', 'billing.refund', 'billing.reconciliation.run',
  'platform.settings.update', 'platform.revoke', 'platform.model.status', 'asset.scan',
  'content.codex.prepare', 'content.codex.commit', 'knowledge.rule.update',
])
const forbiddenTools = toolNames.filter(name => name.startsWith('ops.') || forbiddenMerchantTools.has(name))
const missingTools = requiredTools.filter(name => !toolNames.includes(name))
const mismatchedFiles = files.filter(file => !file.matches).map(file => file.path)
const toolCacheDrift = mismatchedFiles.some(path => path === 'mcp/bridge.mjs' || path === '.mcp.json')
  || missingFromInstalled.length > 0
  || unexpectedInInstalled.length > 0
  || duplicateTools.length > 0
  || Boolean(sourceDiscovery.error)
  || Boolean(installedDiscovery.error)
  || !toolSnapshotMatches
  || Boolean(unconfiguredError)
const connectHelperSourcePaths = [
  'macos/store-nova-connect-helper.swift', 'scripts/build-connect-helper.mjs', 'scripts/connect-local-macos.mjs',
  'windows/StoreNovaConnectHelper.cs', 'scripts/build-connect-helper-windows.mjs', 'scripts/verify-connect-helper-windows.ps1',
]
const connectHelperSourceVerified = !missingRuntimeFiles.some(path => connectHelperSourcePaths.includes(path))
  && !mismatchedFiles.some(path => connectHelperSourcePaths.includes(path))
const ok = mismatchedFiles.length === 0
  && provenance.ok
  && missingRuntimeFiles.length === 0
  && unexpectedRuntimeFiles.length === 0
  && manifestErrors.length === 0
  && sourceVersionErrors.length === 0
  && !sourceDiscovery.error
  && !installedDiscovery.error
  && !unconfiguredError
  && missingFromInstalled.length === 0
  && unexpectedInInstalled.length === 0
  && duplicateTools.length === 0
  && missingTools.length === 0
  && forbiddenTools.length === 0

const evidence = {
  ok,
  bundle_provenance: provenance,
  plugin_version: manifest.version,
  expected_plugin_version: expectedVersion,
  source_manifest: { version: sourceManifestVersion, package_version: sourcePackageVersion, errors: sourceVersionErrors },
  package_profile: { expected: expectedPackageProfile, source: sourcePackageProfile, installed: installedPackageProfile, errors: packageProfileErrors },
  manifest: { errors: manifestErrors },
  source_root: sourceRoot,
  installed_root: installedRoot,
  runtime_files: files,
  runtime_inventory: {
    source_count: sourceRuntimeFiles.length,
    installed_count: installedRuntimeFiles.length,
    missing: missingRuntimeFiles,
    unexpected: unexpectedRuntimeFiles,
  },
  tools: {
    count: toolNames.length,
    source_count: sourceToolNames.length,
    source_discovery_error: sourceDiscovery.error ?? null,
    installed_discovery_error: installedDiscovery.error ?? null,
    source_snapshot_sha256: sourceToolSnapshotSha256,
    installed_snapshot_sha256: installedToolSnapshotSha256,
    snapshot_matches: toolSnapshotMatches,
    unconfigured_call: { tool: 'workspace.health', blocked: !unconfiguredError, code: unconfiguredCode ?? null, error: unconfiguredError },
    required: requiredTools,
    missing: missingTools,
    forbidden: forbiddenTools,
    missing_from_installed: missingFromInstalled,
    unexpected_in_installed: unexpectedInInstalled,
    duplicates: duplicateTools,
    cache_drift: {
      detected: toolCacheDrift,
      action: toolCacheDrift
        ? 'Reinstall the plugin from the verified source and fully restart ChatGPT/Codex. Do not reuse an old conversation tool snapshot.'
        : 'No source-versus-installed tool surface drift detected.',
      automatic_reuse: false,
      automatic_deletion: false,
    },
  },
  current_conversation_refresh: {
    verified: false,
    reason: 'The installed bridge can be verified, but an already-running ChatGPT conversation may retain its original tool snapshot.',
  },
  connect_helper: {
    source_verified: connectHelperSourceVerified,
    app_bundle_verified: false,
    custom_scheme: 'development_recovery_only',
    production_ready: false,
    reason: 'Unsigned custom-scheme platform binaries are not a production connection path; require trusted signing and installation-instance binding.',
    platforms: {
      darwin: { source_verified: connectHelperSourceVerified, signed_bundle_verified: false, production_ready: false },
      win32: { source_verified: connectHelperSourceVerified, sha256_verified: false, authenticode_verified: false, production_ready: false },
    },
  },
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
if (!ok) process.exitCode = 1
