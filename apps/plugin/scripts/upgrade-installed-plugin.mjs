#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { provenanceFile, verifyBundleProvenance } from './bundle-provenance.mjs'
import { packageProfileManifest } from './local-plugin-package-profile.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = resolve(scriptDirectory, '..')
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) throw new Error(`invalid argument: ${name ?? ''}`)
  args.set(name.slice(2), value)
}

const sourceRoot = resolve(args.get('source') ?? defaultSourceRoot)
const marketplace = args.get('marketplace') ?? 'merchant-local'
const localSourceRoot = resolve(args.get('local-source') ?? resolve(sourceRoot, '..', '..', '.codex-marketplace'))
const plugin = args.get('plugin') ?? 'merchant-marketing'
const codex = args.get('codex') ?? 'codex'
const codexHome = resolve(args.get('codex-home') ?? process.env.CODEX_HOME ?? resolve(process.env.HOME ?? '', '.codex'))
const manifest = JSON.parse(readFileSync(resolve(sourceRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
const requestedPackageProfile = args.get('package-profile') ?? null
if (requestedPackageProfile && requestedPackageProfile !== 'qa-broker') {
  throw new Error('upgrade package profile must be qa-broker when explicitly provided')
}
if (manifest.id !== plugin) throw new Error(`source plugin manifest id must be ${plugin}`)
if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('source plugin version is missing or invalid')
if (String(packageJson.version ?? '') !== version) throw new Error('source plugin manifest and package versions differ; refusing to install an ambiguous build')

const sourceProvenancePath = resolve(sourceRoot, provenanceFile)
if (existsSync(sourceProvenancePath)) {
  const provenance = verifyBundleProvenance(sourceRoot)
  if (!provenance.ok || provenance.version !== version) {
    throw new Error(`source bundle provenance is invalid or does not bind plugin ${plugin} version ${version}: ${provenance.errors.join('; ') || 'identity mismatch'}`)
  }
}

let canonicalMarketplaceRoot
try { canonicalMarketplaceRoot = realpathSync(localSourceRoot) }
catch { throw new Error(`local marketplace source is missing or unreadable: ${localSourceRoot}`) }
const marketplaceDocument = JSON.parse(readFileSync(resolve(canonicalMarketplaceRoot, 'marketplace.json'), 'utf8'))
if (marketplaceDocument.name !== marketplace) throw new Error(`local marketplace source declares ${marketplaceDocument.name ?? 'no name'}, not ${marketplace}`)
const pluginEntry = marketplaceDocument.plugins?.filter(entry => entry?.name === plugin) ?? []
if (pluginEntry.length !== 1 || pluginEntry[0].source?.source !== 'local' || typeof pluginEntry[0].source.path !== 'string') {
  throw new Error(`local marketplace must declare exactly one local source for ${plugin}`)
}
let marketplacePluginRoot
try { marketplacePluginRoot = realpathSync(resolve(canonicalMarketplaceRoot, pluginEntry[0].source.path)) }
catch { throw new Error(`local marketplace plugin source is missing or unreadable: ${pluginEntry[0].source.path}`) }
const expectedMarketplacePluginRoot = resolve(canonicalMarketplaceRoot, 'plugins', plugin)
if (marketplacePluginRoot !== expectedMarketplacePluginRoot) {
  throw new Error(`local marketplace source for ${plugin} must resolve to ${expectedMarketplacePluginRoot}`)
}
const marketplaceManifest = JSON.parse(readFileSync(resolve(marketplacePluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const marketplacePackage = JSON.parse(readFileSync(resolve(marketplacePluginRoot, 'package.json'), 'utf8'))
if (marketplaceManifest.id !== plugin || marketplaceManifest.version !== version || marketplacePackage.version !== version) {
  throw new Error(`local marketplace plugin manifest/package version must match source plugin ${plugin} ${version}`)
}

const marketplaceList = spawnSync(codex, ['plugin', 'marketplace', 'list', '--json'], { encoding: 'utf8', timeout: 10_000 })
if (marketplaceList.error || marketplaceList.status !== 0) {
  throw new Error(marketplaceList.stderr?.trim() || 'cannot inspect configured local plugin sources')
}
let marketplaceRows
try { marketplaceRows = JSON.parse(marketplaceList.stdout).marketplaces }
catch { throw new Error('Codex returned an invalid JSON marketplace list') }
const configuredMarketplace = Array.isArray(marketplaceRows)
  ? marketplaceRows.find(row => row?.name === marketplace)
  : undefined
let configuredMarketplaceRoot
try { if (configuredMarketplace?.root) configuredMarketplaceRoot = realpathSync(configuredMarketplace.root) }
catch { /* missing/unreadable registration fails closed below */ }
let configuredSourceRoot
try {
  if (configuredMarketplace?.marketplaceSource?.sourceType === 'local' && configuredMarketplace.marketplaceSource.source) {
    configuredSourceRoot = realpathSync(configuredMarketplace.marketplaceSource.source)
  }
} catch { /* missing/unreadable local source fails closed below */ }
if (configuredMarketplaceRoot !== canonicalMarketplaceRoot || configuredSourceRoot !== canonicalMarketplaceRoot) {
  throw new Error(`Codex marketplace ${marketplace} does not resolve to the expected local source ${canonicalMarketplaceRoot}`)
}

function verifyRuntimeAgainst(installedRoot, label, enforceRequestedProfile = false) {
  const verifyArguments = [resolve(scriptDirectory, 'verify-installed-bridge.mjs'), '--source', sourceRoot, '--installed', installedRoot, '--expected-version', version]
  if (enforceRequestedProfile && requestedPackageProfile) verifyArguments.push('--expected-package-profile', requestedPackageProfile)
  const result = spawnSync(process.execPath, verifyArguments, {
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  })
  let evidence
  try { evidence = JSON.parse(result.stdout) } catch { /* preserve a concise failure below */ }
  if (result.error || result.status !== 0 || evidence?.ok !== true) {
    const failures = [
      ...(evidence?.bundle_provenance?.errors ?? []),
      ...(evidence?.source_manifest?.errors ?? []),
      ...(evidence?.manifest?.errors ?? []),
      ...(evidence?.runtime_inventory?.missing ?? []).map(path => `missing ${path}`),
      ...(evidence?.runtime_inventory?.unexpected ?? []).map(path => `unexpected ${path}`),
      ...(evidence?.runtime_files ?? []).filter(file => !file.matches).map(file => `digest differs: ${file.path}`),
      ...(evidence?.tools?.missing_from_installed ?? []).map(name => `tool missing: ${name}`),
      ...(evidence?.tools?.unexpected_in_installed ?? []).map(name => `unexpected tool: ${name}`),
      ...(evidence?.tools?.forbidden ?? []).map(name => `forbidden tool: ${name}`),
      evidence?.tools?.source_discovery_error,
      evidence?.tools?.installed_discovery_error,
      evidence?.tools?.unconfigured_call?.error,
    ].filter(Boolean)
    throw new Error(`PLUGIN_VERSION_CONTENT_COLLISION: ${label} does not match source plugin ${plugin} ${version}: ${failures.join('; ') || result.stderr?.trim() || result.error?.message || 'runtime verification failed'}. Versioned plugin content is immutable; publish and install a new plugin version.`)
  }
  return evidence
}

// The marketplace is the actual source Codex will install. Verify its complete
// runtime tree and tools before asking Codex to mutate the local cache.
verifyRuntimeAgainst(marketplacePluginRoot, 'local marketplace plugin source')

if (requestedPackageProfile === 'qa-broker') {
  for (const [root, label] of [[sourceRoot, 'source'], [marketplacePluginRoot, 'marketplace']]) {
    if (!existsSync(resolve(root, 'mcp/keychain-broker.mjs'))) throw new Error(`${label} QA package source is missing the credential broker`)
  }
}

const installedRoot = resolve(args.get('installed') ?? resolve(codexHome, 'plugins/cache', marketplace, plugin, version))
if (existsSync(installedRoot)) {
  // A version is immutable. Never let `plugin add` overwrite an already-used
  // versioned cache directory whose bytes no longer match its declared source.
  verifyRuntimeAgainst(installedRoot, `existing cache for immutable version ${version}`, true)
}
const selector = `${plugin}@${marketplace}`
// Codex accepts local marketplaces from the trusted checkout boundary. Keep
// the staging sibling to the canonical marketplace, then remove it after the
// canonical registration is restored.
const stagingContainer = requestedPackageProfile ? mkdtempSync(resolve(dirname(canonicalMarketplaceRoot), '.storenova-qa-stage-')) : null
const stagingMarketplace = stagingContainer
let marketplaceMayHaveChanged = false
function readRegisteredMarketplace() {
  const result = spawnSync(codex, ['plugin', 'marketplace', 'list', '--json'], { encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`cannot inspect Codex marketplace registry during QA-stage recovery: ${result.stderr?.trim() || result.error?.message || `exit ${result.status ?? 'unknown'}`}`)
  }
  let rows
  try { rows = JSON.parse(result.stdout).marketplaces }
  catch { throw new Error('Codex returned invalid marketplace JSON during QA-stage recovery') }
  const row = Array.isArray(rows) ? rows.find(value => value?.name === marketplace) : undefined
  if (!row) return null
  let root, sourceRoot
  try {
    root = row.root ? realpathSync(row.root) : null
    if (row.marketplaceSource?.sourceType === 'local' && row.marketplaceSource.source) {
      sourceRoot = realpathSync(row.marketplaceSource.source)
    }
  } catch { /* report the registered but unreadable path below */ }
  return { root, sourceRoot, rawRoot: row.root ?? null, rawSource: row.marketplaceSource?.source ?? null }
}

function isCanonicalRegistration(registration) {
  return registration?.root === canonicalMarketplaceRoot && registration?.sourceRoot === canonicalMarketplaceRoot
}

function restoreCanonicalMarketplace() {
  let lastAction = 'none'
  let lastCommandError = ''
  let lastRegistration = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let registration
    try { registration = readRegisteredMarketplace() }
    catch (error) {
      lastAction = 'inspect marketplace registry'
      lastCommandError = error instanceof Error ? error.message : String(error)
      continue
    }
    lastRegistration = registration
    if (isCanonicalRegistration(registration)) return
    if (registration && registration.root !== stagingContainer) {
      lastAction = 'inspect marketplace registry'
      lastCommandError = `unexpected registration ${registration.rawRoot ?? 'unreadable'}; left untouched`
      break
    }
    if (registration) {
      const remove = spawnSync(codex, ['plugin', 'marketplace', 'remove', marketplace, '--json'], { encoding: 'utf8', timeout: 10_000 })
      lastAction = 'remove staged marketplace'
      lastCommandError = remove.error?.message || remove.stderr?.trim() || (remove.status === 0 ? '' : `exit ${remove.status ?? 'unknown'}`)
      // Always inspect the registry on the next pass; Codex may mutate before
      // returning a timeout or non-zero status.
    } else {
      const add = spawnSync(codex, ['plugin', 'marketplace', 'add', canonicalMarketplaceRoot, '--json'], { encoding: 'utf8', timeout: 10_000 })
      lastAction = 'add canonical marketplace'
      lastCommandError = add.error?.message || add.stderr?.trim() || (add.status === 0 ? '' : `exit ${add.status ?? 'unknown'}`)
    }
  }
  let actual = lastRegistration
  try { actual = readRegisteredMarketplace() }
  catch (error) {
    lastAction = 'inspect marketplace registry'
    lastCommandError = error instanceof Error ? error.message : String(error)
    actual = null
  }
  const actualDescription = actual
    ? `registered root=${actual.rawRoot ?? 'unreadable'}, source=${actual.rawSource ?? 'unreadable'}`
    : lastAction === 'inspect marketplace registry' ? 'actual registry state could not be read' : 'marketplace registration is missing'
  throw new Error(`QA_STAGE_REGISTRY_RECOVERY_FAILED: could not restore canonical marketplace ${canonicalMarketplaceRoot}; ${actualDescription}; last action=${lastAction}${lastCommandError ? ` (${lastCommandError})` : ''}. Manual recovery: run codex plugin marketplace remove ${marketplace} --json, then codex plugin marketplace add ${canonicalMarketplaceRoot} --json, and verify with codex plugin marketplace list --json.`)
}

let operationError
let recoveryError
let cleanupError
try {
  if (stagingMarketplace) {
    const stagedPlugin = resolve(stagingMarketplace, 'plugin')
    cpSync(marketplacePluginRoot, stagedPlugin, { recursive: true })
    writeFileSync(resolve(stagedPlugin, 'bundle-profile.json'), `${JSON.stringify(packageProfileManifest(requestedPackageProfile), null, 2)}\n`, { flag: 'wx', mode: 0o444 })
    mkdirSync(resolve(stagingMarketplace, '.agents/plugins'), { recursive: true })
    writeFileSync(resolve(stagingMarketplace, '.agents/plugins/marketplace.json'), `${JSON.stringify({ ...marketplaceDocument,
      plugins: [{ ...pluginEntry[0], source: { source: 'local', path: './plugin' } }] }, null, 2)}\n`)
    verifyRuntimeAgainst(stagedPlugin, 'staged QA marketplace plugin', true)
    // Mark the swap as potentially active before invoking Codex: a timeout or
    // non-zero exit can occur after it has already removed the registration.
    marketplaceMayHaveChanged = true
    const removeOriginal = spawnSync(codex, ['plugin', 'marketplace', 'remove', marketplace, '--json'], { encoding: 'utf8', timeout: 10_000 })
    if (removeOriginal.error || removeOriginal.status !== 0) throw new Error(removeOriginal.stderr?.trim() || 'cannot detach original marketplace for staged QA install')
    const addStaging = spawnSync(codex, ['plugin', 'marketplace', 'add', stagingContainer, '--json'], { encoding: 'utf8', timeout: 10_000 })
    if (addStaging.error || addStaging.status !== 0) throw new Error(addStaging.stderr?.trim() || 'cannot register staged QA marketplace')
  }
  const install = spawnSync(codex, ['plugin', 'add', selector, '--json'], { encoding: 'utf8', timeout: 30_000 })
  if (install.error || install.status !== 0) throw new Error(install.stderr?.trim() || `Codex plugin upgrade failed with exit ${install.status ?? 'unknown'}`)
} catch (error) {
  operationError = error
} finally {
  if (marketplaceMayHaveChanged) {
    try { restoreCanonicalMarketplace() }
    catch (error) { recoveryError = error }
  }
  if (stagingContainer) {
    try { rmSync(stagingContainer, { recursive: true, force: true }) }
    catch (error) { cleanupError = error }
  }
}
if (operationError || recoveryError || cleanupError) {
  const messages = [operationError, recoveryError, cleanupError].filter(Boolean).map(error => error instanceof Error ? error.message : String(error))
  throw new Error(messages.join('\nAdditional recovery status: '))
}
if (!existsSync(installedRoot)) {
  process.stderr.write(`Codex reported success but the versioned install is missing: ${installedRoot}\n`)
  process.exit(1)
}

const installedEvidence = verifyRuntimeAgainst(installedRoot, 'installed plugin cache', true)
if (process.platform === 'darwin') {
  // The local marketplace copies source files, not the machine-specific
  // Keychain binary. Build it in the verified cache before declaring the
  // upgrade usable by ChatGPT; otherwise MCP exits during initialize.
  const helperBuild = spawnSync(process.execPath, [resolve(installedRoot, 'scripts/build-keychain-helper.mjs')], {
    encoding: 'utf8', timeout: 120_000,
  })
  if (helperBuild.error || helperBuild.status !== 0) {
    throw new Error(`installed macOS Keychain helper build failed: ${helperBuild.stderr?.trim() || helperBuild.error?.message || 'unknown error'}`)
  }
}
process.stdout.write(`${JSON.stringify(installedEvidence, null, 2)}\n`)
process.stderr.write(`Verified ${selector} ${version}. Fully restart ChatGPT/Codex and open a new conversation.\n`)
