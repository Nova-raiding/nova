#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { provenanceFile, verifyBundleProvenance } from './bundle-provenance.mjs'

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

function verifyRuntimeAgainst(installedRoot, label) {
  const result = spawnSync(process.execPath, [resolve(scriptDirectory, 'verify-installed-bridge.mjs'), '--source', sourceRoot, '--installed', installedRoot, '--expected-version', version], {
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
    throw new Error(`${label} does not match source plugin ${plugin} ${version}: ${failures.join('; ') || result.stderr?.trim() || result.error?.message || 'runtime verification failed'}`)
  }
  return evidence
}

// The marketplace is the actual source Codex will install. Verify its complete
// runtime tree and tools before asking Codex to mutate the local cache.
verifyRuntimeAgainst(marketplacePluginRoot, 'local marketplace plugin source')

const installedRoot = resolve(args.get('installed') ?? resolve(codexHome, 'plugins/cache', marketplace, plugin, version))
if (existsSync(installedRoot)) {
  // A version is immutable. Never let `plugin add` overwrite an already-used
  // versioned cache directory whose bytes no longer match its declared source.
  verifyRuntimeAgainst(installedRoot, `existing cache for immutable version ${version}`)
}
const selector = `${plugin}@${marketplace}`
const install = spawnSync(codex, ['plugin', 'add', selector, '--json'], { encoding: 'utf8', timeout: 30_000 })
if (install.error || install.status !== 0) {
  process.stderr.write(install.stderr || `Codex plugin upgrade failed with exit ${install.status ?? 'unknown'}\n`)
  process.exit(1)
}
if (!existsSync(installedRoot)) {
  process.stderr.write(`Codex reported success but the versioned install is missing: ${installedRoot}\n`)
  process.exit(1)
}

const installedEvidence = verifyRuntimeAgainst(installedRoot, 'installed plugin cache')
process.stdout.write(`${JSON.stringify(installedEvidence, null, 2)}\n`)
process.stderr.write(`Verified ${selector} ${version}. Fully restart ChatGPT/Codex and open a new conversation.\n`)
