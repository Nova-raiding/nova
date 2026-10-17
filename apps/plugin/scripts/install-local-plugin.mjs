#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = resolve(scriptDirectory, '..')
const defaultRepositoryRoot = resolve(defaultSourceRoot, '..', '..')
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) throw new Error(`invalid argument: ${name ?? ''}`)
  const key = name.slice(2)
  if (args.has(key)) throw new Error(`argument may be specified only once: ${name}`)
  args.set(key, value)
}

const sourceRoot = resolve(args.get('source') ?? defaultSourceRoot)
const localSourceRoot = resolve(args.get('local-source') ?? resolve(defaultRepositoryRoot, '.codex-marketplace'))
const codex = args.get('codex') ?? 'codex'
const codexHome = resolve(args.get('codex-home') ?? process.env.CODEX_HOME ?? resolve(process.env.HOME ?? '', '.codex'))
const requestedPackageProfile = args.get('package-profile') ?? null
if (requestedPackageProfile && !['production', 'qa-broker'].includes(requestedPackageProfile)) {
  throw new Error('local source package profile must be production or qa-broker')
}
const manifest = JSON.parse(readFileSync(resolve(sourceRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
const plugin = String(manifest.id ?? '')

if (!existsSync(resolve(localSourceRoot, 'marketplace.json'))) throw new Error(`local plugin source adapter is missing: ${localSourceRoot}`)
if (plugin !== 'merchant-marketing') throw new Error('local package manifest id must be merchant-marketing')
if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('local package version is missing or invalid')
if (String(packageJson.version ?? '') !== version) throw new Error('local package manifest and package versions differ')

const marketplace = JSON.parse(readFileSync(resolve(localSourceRoot, 'marketplace.json'), 'utf8'))
const marketplaceName = String(marketplace.name ?? '')
if (!marketplaceName) throw new Error('local plugin source adapter has no name')

const pluginEntries = marketplace.plugins?.filter(entry => entry?.name === plugin) ?? []
if (pluginEntries.length !== 1 || pluginEntries[0].source?.source !== 'local' || typeof pluginEntries[0].source.path !== 'string') {
  throw new Error(`local marketplace must declare exactly one local source for ${plugin}`)
}
const canonicalMarketplaceRoot = realpathSync(localSourceRoot)
const marketplacePluginRoot = realpathSync(resolve(canonicalMarketplaceRoot, pluginEntries[0].source.path))
const expectedMarketplacePluginRoot = resolve(canonicalMarketplaceRoot, 'plugins', plugin)
if (marketplacePluginRoot !== expectedMarketplacePluginRoot) {
  throw new Error(`local marketplace source for ${plugin} must resolve to ${expectedMarketplacePluginRoot}`)
}

function verifySameVersionRuntime(candidateRoot, label) {
  const candidateManifest = JSON.parse(readFileSync(resolve(candidateRoot, '.codex-plugin/plugin.json'), 'utf8'))
  const candidatePackage = JSON.parse(readFileSync(resolve(candidateRoot, 'package.json'), 'utf8'))
  if (candidateManifest.id !== plugin || candidateManifest.version !== version || candidatePackage.version !== version) {
    throw new Error(`${label} manifest/package must match source plugin ${plugin} ${version}`)
  }
  const profilePath = resolve(candidateRoot, 'bundle-profile.json')
  const profile = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : null
  if (profile?.profile === 'qa-broker' && requestedPackageProfile !== 'qa-broker') {
    throw new Error('QA_BROKER_REQUIRES_EXPLICIT_OPT_IN: QA credentials are process-memory only. Use native local source for durable Keychain credentials, or explicitly select --package-profile qa-broker for temporary QA.')
  }
  const verifyArgs = [resolve(scriptDirectory, 'verify-installed-bridge.mjs'), '--source', sourceRoot, '--installed', candidateRoot, '--expected-version', version]
  if (requestedPackageProfile === 'qa-broker' || profile) verifyArgs.push('--expected-package-profile', requestedPackageProfile ?? 'production')
  const result = spawnSync(process.execPath, verifyArgs, {
    encoding: 'utf8', env: process.env, timeout: 20_000,
  })
  let evidence
  try { evidence = JSON.parse(result.stdout) } catch { /* concise fail-closed error below */ }
  if (result.error || result.status !== 0 || evidence?.ok !== true) {
    const differences = [
      ...(evidence?.runtime_inventory?.missing ?? []).map(path => `missing ${path}`),
      ...(evidence?.runtime_inventory?.unexpected ?? []).map(path => `unexpected ${path}`),
      ...(evidence?.runtime_files ?? []).filter(file => !file.matches).map(file => `digest differs: ${file.path}`),
    ]
    throw new Error(`PLUGIN_VERSION_CONTENT_COLLISION: ${label} differs from source plugin ${plugin} ${version}: ${differences.join('; ') || result.stderr?.trim() || result.error?.message || 'runtime verification failed'}. Versioned plugin content is immutable; publish and install a new plugin version.`)
  }
}

// The marketplace mirror is what Codex copies. Reject a reused version before
// registering the marketplace or mutating the versioned cache.
verifySameVersionRuntime(marketplacePluginRoot, 'local marketplace plugin mirror')

const installedRoot = resolve(args.get('installed') ?? resolve(codexHome, 'plugins/cache', marketplaceName, plugin, version))
if (existsSync(installedRoot)) verifySameVersionRuntime(installedRoot, `existing cache for immutable version ${version}`)

const runCodex = commandArgs => spawnSync(codex, commandArgs, { encoding: 'utf8', timeout: 30_000 })
const expectedMarketplaceRoot = canonicalMarketplaceRoot
function inspectRegistration() {
  const result = runCodex(['plugin', 'marketplace', 'list', '--json'])
  if (result.error || result.status !== 0) {
    throw new Error(`cannot inspect Codex marketplace registry: ${result.stderr?.trim() || result.error?.message || `exit ${result.status ?? 'unknown'}`}`)
  }
  let rows
  try { rows = JSON.parse(result.stdout).marketplaces }
  catch { throw new Error('Codex returned invalid marketplace JSON') }
  const row = Array.isArray(rows) ? rows.find(value => value?.name === marketplaceName) : undefined
  if (!row) return null
  let root = null
  let sourceRoot = null
  try { if (row.root) root = realpathSync(row.root) } catch { /* report as unknown below */ }
  try {
    if (row.marketplaceSource?.sourceType === 'local' && row.marketplaceSource.source) {
      sourceRoot = realpathSync(row.marketplaceSource.source)
    }
  } catch { /* report as unknown below */ }
  return { root, sourceRoot, rawRoot: row.root ?? null, rawSource: row.marketplaceSource?.source ?? null }
}
const isExpectedRegistration = registration => registration?.root === expectedMarketplaceRoot
  && registration?.sourceRoot === expectedMarketplaceRoot
const describeRegistration = registration => registration
  ? `root=${registration.rawRoot ?? 'unreadable'}, source=${registration.rawSource ?? 'unreadable'}`
  : 'marketplace registration is missing'

// Codex may evict the whole plugin cache during add, even while an old
// bridge still uses its helper and profile. Restore those exact files after
// the CLI returns; this does not replace the required host restart.
const preservedCaches = []
let previousCacheBackup
const backupParent = resolve(codexHome, 'plugins')
function preservePreviousCaches() {
  const cacheRoot = dirname(installedRoot)
  if (!existsSync(cacheRoot)) return
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(entry.name)) continue
    const original = resolve(cacheRoot, entry.name)
    if (original === installedRoot) continue
    if (!previousCacheBackup) {
      // Keep backups outside the subtree the CLI is allowed to evict.
      mkdirSync(backupParent, { recursive: true })
      previousCacheBackup = mkdtempSync(resolve(backupParent, '.storenova-previous-cache-'))
    }
    const backup = resolve(previousCacheBackup, entry.name)
    cpSync(original, backup, { recursive: true })
    preservedCaches.push({ original, backup })
  }
}
function restorePreviousCaches() {
  for (const { original, backup } of preservedCaches) {
    if (existsSync(original)) continue
    // Preserve concurrent installs unchanged. Keep the backup if copying fails.
    cpSync(backup, original, { recursive: true, force: false, errorOnExist: true })
  }
}
function finishPreviousCaches() {
  try { restorePreviousCaches() }
  catch (error) {
    throw new Error(`LOCAL_PLUGIN_PREVIOUS_CACHE_RECOVERY_FAILED: previous runtime files could not be restored; backup remains at ${previousCacheBackup}: ${error instanceof Error ? error.message : 'copy failed'}`)
  }
  if (previousCacheBackup) {
    try { rmSync(previousCacheBackup, { recursive: true, force: true }) }
    catch (error) {
      throw new Error(`LOCAL_PLUGIN_BACKUP_CLEANUP_FAILED: previous runtime files restored but backup could not be removed: ${error instanceof Error ? error.message : 'cleanup failed'}; backup directory=${previousCacheBackup}`)
    }
  }
}

const cacheExistedAtStart = existsSync(installedRoot)
let rollbackDirectory = null
let backupCachePath = null
let backupComplete = false
let marketplaceMayHaveBeenAdded = false
let cacheMayHaveBeenMutated = false
let installError
try {
  const before = inspectRegistration()
  if (before && !isExpectedRegistration(before)) {
    throw new Error(`LOCAL_PLUGIN_UNKNOWN_MARKETPLACE: ${marketplaceName} already resolves to another or unreadable source (${describeRegistration(before)}); leaving it untouched`)
  }

  preservePreviousCaches()
  if (cacheExistedAtStart) {
    mkdirSync(backupParent, { recursive: true })
    rollbackDirectory = mkdtempSync(resolve(backupParent, '.storenova-local-install-rollback-'))
    backupCachePath = resolve(rollbackDirectory, 'cache')
    cpSync(installedRoot, backupCachePath, { recursive: true })
    backupComplete = true
  }

  if (!before) {
    // A failed CLI response can arrive after the registry mutation. Record
    // ownership intent before the call, then inspect actual state in rollback.
    marketplaceMayHaveBeenAdded = true
    const addSource = runCodex(['plugin', 'marketplace', 'add', localSourceRoot, '--json'])
    let afterAdd
    try { afterAdd = inspectRegistration() }
    catch (error) { throw new Error(`LOCAL_PLUGIN_MARKETPLACE_ADD_STATE_UNKNOWN: ${addSource.stderr?.trim() || error.message}`) }
    if (afterAdd && !isExpectedRegistration(afterAdd)) {
      const commandFailure = addSource.error?.message || addSource.stderr?.trim() || (addSource.status === 0 ? '' : `exit ${addSource.status ?? 'unknown'}`)
      throw new Error(`LOCAL_PLUGIN_UNKNOWN_MARKETPLACE: marketplace add produced an unexpected registration (${describeRegistration(afterAdd)}); leaving it untouched${commandFailure ? `; marketplace add reported: ${commandFailure}` : ''}`)
    }
    if (addSource.error || addSource.status !== 0) {
      throw new Error(addSource.stderr?.trim() || addSource.error?.message || 'cannot register local plugin source')
    }
    if (!isExpectedRegistration(afterAdd)) throw new Error('Codex reported success but the expected local marketplace registration is missing')
  }

  cacheMayHaveBeenMutated = true
  const install = runCodex(['plugin', 'add', `${plugin}@${marketplaceName}`, '--json'])
  if (install.error || install.status !== 0) throw new Error(install.stderr?.trim() || install.error?.message || 'local plugin installation failed')

  if (!existsSync(installedRoot)) throw new Error(`Codex reported success but the local install is missing: ${installedRoot}`)
  try { verifySameVersionRuntime(installedRoot, 'installed local plugin') }
  catch (error) {
    throw new Error(`installed local plugin differs from its source package: ${error instanceof Error ? error.message : 'runtime verification failed'}`)
  }

  if (process.platform === 'darwin') {
  // Marketplace copies contain the Swift source but not the host-built binary.
  // Build and validate it in the versioned cache before claiming the MCP is
  // usable; the bridge fails during startup when either artifact is absent.
  const helperPath = resolve(installedRoot, 'mcp/keychain-credential-helper')
  const buildInfoPath = resolve(installedRoot, 'mcp/keychain-credential-helper.build.json')
  // Do not accept stale artifacts copied from a prior cache or bundled source.
  rmSync(helperPath, { force: true })
  rmSync(buildInfoPath, { force: true })
  const helperBuild = spawnSync(process.execPath, [resolve(installedRoot, 'scripts/build-keychain-helper.mjs')], {
    encoding: 'utf8', env: process.env, timeout: 120_000,
  })
  if (helperBuild.error || helperBuild.status !== 0) {
    throw new Error(`LOCAL_PLUGIN_KEYCHAIN_BUILD_FAILED: ${helperBuild.stderr?.trim() || helperBuild.error?.message || 'macOS Keychain helper build failed'}`)
  }
  const sourcePath = resolve(installedRoot, 'mcp/keychain-credential-helper.swift')
  try {
    const helper = statSync(helperPath)
    const sourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
    const binarySha256 = createHash('sha256').update(readFileSync(helperPath)).digest('hex')
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
    if (!helper.isFile() || !(helper.mode & 0o111)
      || buildInfo?.schema_version !== '1' || buildInfo.platform !== process.platform || buildInfo.arch !== process.arch
      || buildInfo.source_sha256 !== sourceSha256 || buildInfo.binary_sha256 !== binarySha256) {
      throw new Error('helper or build manifest does not match the installed source/runtime')
    }
  } catch (error) {
    throw new Error(`LOCAL_PLUGIN_KEYCHAIN_HELPER_INVALID: ${error instanceof Error ? error.message : 'missing or invalid build artifacts'}`)
  }
}
} catch (error) {
  installError = error
}

if (installError) {
  const rollbackErrors = []
  // Registry rollback may also evict caches. Finish every CLI mutation before
  // restoring runtime files or deleting either kind of recovery backup.
  if (marketplaceMayHaveBeenAdded) {
    try {
      let state = inspectRegistration()
      for (let attempt = 0; isExpectedRegistration(state) && attempt < 3; attempt += 1) {
        // Even if plugin add was never reached, removing a newly registered
        // marketplace can evict the pre-existing target cache.
        cacheMayHaveBeenMutated = true
        runCodex(['plugin', 'marketplace', 'remove', marketplaceName, '--json'])
        state = inspectRegistration()
      }
      if (state && !isExpectedRegistration(state)) {
        rollbackErrors.push(`LOCAL_PLUGIN_REGISTRY_ROLLBACK_SKIPPED: unexpected registration remains (${describeRegistration(state)}); left untouched`)
      } else if (isExpectedRegistration(state)) {
        rollbackErrors.push(`LOCAL_PLUGIN_REGISTRY_ROLLBACK_FAILED: expected registry still points to ${expectedMarketplaceRoot}; manually run codex plugin marketplace remove ${marketplaceName} --json, then verify with codex plugin marketplace list --json`)
      }
    } catch (error) {
      rollbackErrors.push(`LOCAL_PLUGIN_REGISTRY_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}; inspect with codex plugin marketplace list --json before manually removing ${marketplaceName}`)
    }
  }
  if (cacheMayHaveBeenMutated) {
    try {
      if (cacheExistedAtStart && backupComplete && backupCachePath) {
        if (existsSync(installedRoot)) rmSync(installedRoot, { recursive: true, force: true })
        mkdirSync(dirname(installedRoot), { recursive: true })
        renameSync(backupCachePath, installedRoot)
        verifySameVersionRuntime(installedRoot, 'restored pre-install cache')
      } else if (!cacheExistedAtStart && existsSync(installedRoot)) {
        rmSync(installedRoot, { recursive: true, force: true })
        if (existsSync(installedRoot)) throw new Error('partial plugin cache remains after cleanup')
      }
    } catch (error) {
      rollbackErrors.push(`LOCAL_PLUGIN_CACHE_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}${backupCachePath && existsSync(backupCachePath) ? `; verified backup remains at ${backupCachePath}` : ''}`)
    }
  }
  try { finishPreviousCaches() }
  catch (error) { rollbackErrors.push(error instanceof Error ? error.message : String(error)) }
  if (rollbackDirectory) {
    const preserveBackup = cacheMayHaveBeenMutated && backupComplete && backupCachePath && existsSync(backupCachePath)
    if (preserveBackup) {
      rollbackErrors.push(`LOCAL_PLUGIN_BACKUP_PRESERVED: cache rollback did not finish; recovery backup remains at ${backupCachePath}`)
    } else {
      try { rmSync(rollbackDirectory, { recursive: true, force: true }) }
      catch (error) { rollbackErrors.push(`LOCAL_PLUGIN_BACKUP_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}; backup directory=${rollbackDirectory}`) }
    }
  }
  const originalMessage = installError instanceof Error ? installError.message : String(installError)
  throw new Error([originalMessage, ...rollbackErrors].join('\nAdditional recovery status: '))
}

finishPreviousCaches()
if (rollbackDirectory) {
  try { rmSync(rollbackDirectory, { recursive: true, force: true }) }
  catch (error) {
    throw new Error(`LOCAL_PLUGIN_BACKUP_CLEANUP_FAILED: installation verified but rollback backup could not be removed: ${error instanceof Error ? error.message : String(error)}; backup directory=${rollbackDirectory}`)
  }
}

if (requestedPackageProfile === 'qa-broker') {
  process.stderr.write('QA 测试模式：凭据仅保存在辅助进程内存中，进程退出后需要重新授权；日常使用请安装原生钥匙串模式。\n')
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: 'local_stdio',
  public_marketplace_required: false,
  chatgpt_oauth_required: false,
  plugin,
  version,
  package_profile: requestedPackageProfile ?? 'production',
  local_source: localSourceRoot,
  installed_root: installedRoot,
  restart_required: true,
}, null, 2)}\n`)
