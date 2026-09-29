#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
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
  args.set(name.slice(2), value)
}

const sourceRoot = resolve(args.get('source') ?? defaultSourceRoot)
const localSourceRoot = resolve(args.get('local-source') ?? resolve(defaultRepositoryRoot, '.codex-marketplace'))
const codex = args.get('codex') ?? 'codex'
const codexHome = resolve(args.get('codex-home') ?? process.env.CODEX_HOME ?? resolve(process.env.HOME ?? '', '.codex'))
const requestedPackageProfile = args.get('package-profile') ?? null
if (requestedPackageProfile !== 'qa-broker') {
  throw new Error('local source installation requires --package-profile qa-broker and a separately staged QA package')
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
const marketplacePluginRoot = resolve(localSourceRoot, pluginEntries[0].source.path)

function verifySameVersionRuntime(candidateRoot, label) {
  const candidateManifest = JSON.parse(readFileSync(resolve(candidateRoot, '.codex-plugin/plugin.json'), 'utf8'))
  const candidatePackage = JSON.parse(readFileSync(resolve(candidateRoot, 'package.json'), 'utf8'))
  if (candidateManifest.id !== plugin || candidateManifest.version !== version || candidatePackage.version !== version) {
    throw new Error(`${label} manifest/package must match source plugin ${plugin} ${version}`)
  }
  const result = spawnSync(process.execPath, [resolve(scriptDirectory, 'verify-installed-bridge.mjs'), '--source', sourceRoot, '--installed', candidateRoot, '--expected-version', version, '--expected-package-profile', requestedPackageProfile], {
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
const expectedMarketplaceRoot = realpathSync(localSourceRoot)
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

  if (cacheExistedAtStart) {
    rollbackDirectory = mkdtempSync(resolve(dirname(installedRoot), '.storenova-local-install-rollback-'))
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
  const verifyArgs = [resolve(scriptDirectory, 'verify-installed-bridge.mjs'), '--source', sourceRoot, '--installed', installedRoot, '--expected-version', version, '--expected-package-profile', requestedPackageProfile]
  const verify = spawnSync(process.execPath, verifyArgs, {
    encoding: 'utf8', env: process.env, timeout: 20_000,
  })
  if (verify.error || verify.status !== 0) throw new Error(verify.stderr?.trim() || verify.error?.message || 'installed local plugin differs from its source package')

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
  if (cacheMayHaveBeenMutated) {
    try {
      if (cacheExistedAtStart && backupComplete && backupCachePath) {
        if (existsSync(installedRoot)) rmSync(installedRoot, { recursive: true, force: true })
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
  if (marketplaceMayHaveBeenAdded) {
    try {
      let state = inspectRegistration()
      for (let attempt = 0; isExpectedRegistration(state) && attempt < 3; attempt += 1) {
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

if (rollbackDirectory) {
  try { rmSync(rollbackDirectory, { recursive: true, force: true }) }
  catch (error) {
    throw new Error(`LOCAL_PLUGIN_BACKUP_CLEANUP_FAILED: installation verified but rollback backup could not be removed: ${error instanceof Error ? error.message : String(error)}; backup directory=${rollbackDirectory}`)
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: 'local_stdio',
  public_marketplace_required: false,
  chatgpt_oauth_required: false,
  plugin,
  version,
  package_profile: requestedPackageProfile,
  local_source: localSourceRoot,
  installed_root: installedRoot,
  restart_required: true,
}, null, 2)}\n`)
