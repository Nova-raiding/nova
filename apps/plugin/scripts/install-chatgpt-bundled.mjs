#!/usr/bin/env node
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyBundleProvenance } from './bundle-provenance.mjs'

const defaultSource = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginName = 'merchant-marketing'
const pluginPath = './plugins/merchant-marketing'

function fileContents(path) {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Plugin configuration is not a regular file: ${path}`)
  return readFileSync(path, 'utf8')
}

function assertUnchanged(path, original) {
  if (fileContents(path) !== original) throw new Error(`Plugin configuration changed during installation: ${path}`)
}

function assertKnownPluginDirectory(path) {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Existing plugin directory is not a regular directory: ${path}`)
  const files = ['.codex-plugin/plugin.json', 'package.json', '.mcp.json']
  const records = files.map(file => {
    const target = resolve(path, file)
    if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
      throw new Error(`Existing plugin directory is not recognized as Store Nova: ${path}`)
    }
    try { return JSON.parse(readFileSync(target, 'utf8')) }
    catch { throw new Error(`Existing plugin directory is not recognized as Store Nova: ${path}`) }
  })
  const [manifest, pkg, mcp] = records
  const bridge = resolve(path, 'mcp', 'bridge.mjs')
  if (manifest.id !== pluginName || manifest.name !== pluginName || pkg.name !== '@merchant-marketing/plugin'
    || manifest.version !== pkg.version || manifest.mcpServers !== './.mcp.json'
    || !Array.isArray(mcp.mcpServers?.[pluginName]?.args)
    || mcp.mcpServers[pluginName].args.length !== 1
    || mcp.mcpServers[pluginName].args[0] !== './mcp/bridge.mjs'
    || !existsSync(bridge) || !lstatSync(bridge).isFile() || lstatSync(bridge).isSymbolicLink()) {
    throw new Error(`Existing plugin directory is not recognized as Store Nova: ${path}`)
  }
  return true
}

function nextConfigText(original, marketplaceName) {
  const configSection = `[plugins."${pluginName}@${marketplaceName}"]`
  const lines = original.split('\n')
  const sectionIndex = lines.findIndex(line => line.trim() === configSection)
  if (sectionIndex !== -1) {
    const end = lines.findIndex((line, index) => index > sectionIndex && /^\[/u.test(line.trim()))
    const sectionEnd = end === -1 ? lines.length : end
    const enabled = lines.findIndex((line, index) => index > sectionIndex && index < sectionEnd && /^enabled\s*=/u.test(line.trim()))
    if (enabled === -1) lines.splice(sectionIndex + 1, 0, 'enabled = true')
    else lines[enabled] = 'enabled = true'
  } else lines.push(configSection, 'enabled = true', '')
  return lines.join('\n')
}

/** Test hooks are injected by direct callers only; the bundled CLI accepts no hook arguments. */
export function installBundledPlugin(options = {}) {
  const source = resolve(options.sourceRoot ?? defaultSource)
  const home = resolve(options.home ?? homedir())
  const agentsHome = resolve(options.agentsHome ?? process.env.AGENTS_HOME ?? resolve(home, '.agents'))
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? resolve(home, '.codex'))
  const destination = resolve(home, 'plugins', pluginName)
  const marketplacePath = resolve(agentsHome, 'plugins', 'marketplace.json')
  const configPath = resolve(codexHome, 'config.toml')
  const manifest = JSON.parse(readFileSync(resolve(source, '.codex-plugin/plugin.json'), 'utf8'))
  const packageJson = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'))
  const runtime = resolve(source, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(runtime)) throw new Error('Bundled Node runtime is missing')
  if (manifest.id !== pluginName || manifest.name !== pluginName
    || !/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(manifest.version ?? '')
    || packageJson.name !== '@merchant-marketing/plugin' || packageJson.version !== manifest.version) {
    throw new Error('Bundled plugin manifest is invalid')
  }
  const provenance = verifyBundleProvenance(source)
  if (!provenance.ok) throw new Error(`Bundled plugin provenance check failed: ${provenance.errors.join('; ')}`)
  const oldRegistry = fileContents(marketplacePath)
  const marketplace = oldRegistry === null
    ? { name: 'merchant-personal', interface: { displayName: 'Merchant Marketing' }, plugins: [] }
    : JSON.parse(oldRegistry)
  if (!marketplace || !Array.isArray(marketplace.plugins)) throw new Error('Existing personal plugin registry is invalid')
  if (!/^[A-Za-z0-9_-]+$/u.test(marketplace.name ?? '')) throw new Error('Personal plugin registry name is invalid')
  const matchingEntries = marketplace.plugins.filter(plugin => plugin?.name === pluginName)
  if (matchingEntries.length > 1) throw new Error('Duplicate merchant-marketing registry entries are invalid')
  const currentEntry = matchingEntries[0]
  if (currentEntry && (currentEntry.source?.source !== 'local' || currentEntry.source.path !== pluginPath)) {
    throw new Error('Existing merchant-marketing registry entry has a different source')
  }
  const entry = { name: pluginName, source: { source: 'local', path: pluginPath },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }
  marketplace.plugins = [...marketplace.plugins.filter(plugin => plugin?.name !== pluginName), entry]
  // ChatGPT resolves a local marketplace installation from the literal `local` cache slot.
  const cache = resolve(codexHome, 'plugins', 'cache', marketplace.name, pluginName, 'local')
  if ([destination, cache].some(path => path === source || path.startsWith(`${source}${sep}`)
    || source.startsWith(`${path}${sep}`))) {
    throw new Error('Plugin install destination must be outside the extracted package')
  }
  const sourceExists = assertKnownPluginDirectory(destination)
  const cacheExists = assertKnownPluginDirectory(cache)
  const oldConfig = fileContents(configPath)
  const nextConfig = nextConfigText(oldConfig ?? '', marketplace.name)

  mkdirSync(dirname(destination), { recursive: true })
  mkdirSync(dirname(marketplacePath), { recursive: true })
  mkdirSync(dirname(cache), { recursive: true })
  mkdirSync(dirname(configPath), { recursive: true })
  const staged = mkdtempSync(resolve(dirname(destination), '.merchant-marketing-install-'))
  const stagedCache = mkdtempSync(resolve(dirname(cache), '.merchant-marketing-cache-'))
  const transactionId = randomUUID()
  const temporaryRegistry = resolve(dirname(marketplacePath), `.marketplace-${transactionId}.tmp`)
  const temporaryConfig = resolve(dirname(configPath), `.config-${transactionId}.tmp`)
  const previous = sourceExists ? resolve(dirname(destination), `.merchant-marketing-previous-${transactionId}`) : null
  const previousCache = cacheExists ? resolve(dirname(cache), `.merchant-marketing-cache-previous-${transactionId}`) : null
  const previousConfig = oldConfig === null ? null : resolve(dirname(configPath), `.config-previous-${transactionId}.bak`)
  let movedSource = false, movedCache = false, installedSource = false, installedCache = false, registryWritten = false
  let movedConfig = false
  const nextRegistry = `${JSON.stringify(marketplace, null, 2)}\n`
  try {
    cpSync(source, staged, { recursive: true, filter: path => !relative(source, path).split(/[\\/]/u).includes('.agents') })
    cpSync(source, stagedCache, { recursive: true, filter: path => !relative(source, path).split(/[\\/]/u).includes('.agents') })
    for (const copied of [staged, stagedCache]) {
      const checked = verifyBundleProvenance(copied, { installed: true })
      if (!checked.ok) throw new Error(`Installed plugin provenance check failed: ${checked.errors.join('; ')}`)
    }
    if (!existsSync(resolve(staged, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))) throw new Error('Runtime copy failed')
    writeFileSync(temporaryRegistry, nextRegistry, { mode: 0o600 })
    writeFileSync(temporaryConfig, nextConfig, { mode: 0o600 })
    assertUnchanged(marketplacePath, oldRegistry)
    assertUnchanged(configPath, oldConfig)
    if (previous) { renameSync(destination, previous); movedSource = true }
    if (previousCache) { renameSync(cache, previousCache); movedCache = true }
    renameSync(staged, destination); installedSource = true
    renameSync(stagedCache, cache); installedCache = true
    assertUnchanged(marketplacePath, oldRegistry)
    renameSync(temporaryRegistry, marketplacePath); registryWritten = true
    options.beforeConfigCommit?.()
    assertUnchanged(configPath, oldConfig)
    if (previousConfig) {
      renameSync(configPath, previousConfig); movedConfig = true
      if (fileContents(previousConfig) !== oldConfig) throw new Error('Plugin configuration changed during installation')
    }
    options.afterConfigMoved?.()
    // A hard link is atomic and refuses to replace a file created by another process.
    linkSync(temporaryConfig, configPath)
  } catch (error) {
    if (movedConfig && previousConfig) {
      try { linkSync(previousConfig, configPath); rmSync(previousConfig) }
      catch { /* Keep the old config backup if another process now owns configPath. */ }
    }
    let restoreRegistry = false
    try { restoreRegistry = registryWritten && fileContents(marketplacePath) === nextRegistry } catch { /* Preserve a concurrently replaced registry. */ }
    if (restoreRegistry) {
      if (oldRegistry === null) rmSync(marketplacePath)
      else {
        writeFileSync(temporaryRegistry, oldRegistry, { mode: 0o600 })
        renameSync(temporaryRegistry, marketplacePath)
      }
    }
    if (installedSource) rmSync(destination, { recursive: true, force: true })
    if (movedSource) renameSync(previous, destination)
    if (installedCache) rmSync(cache, { recursive: true, force: true })
    if (movedCache) renameSync(previousCache, cache)
    throw error
  } finally {
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true })
    if (existsSync(stagedCache)) rmSync(stagedCache, { recursive: true, force: true })
    if (existsSync(temporaryRegistry)) rmSync(temporaryRegistry, { force: true })
    if (existsSync(temporaryConfig)) rmSync(temporaryConfig, { force: true })
  }
  return { ok: true, plugin: manifest.name, version: manifest.version,
    installed: cache, source: destination, registry: marketplacePath,
    previous_source: previous, previous_cache: previousCache, previous_config: previousConfig,
    restart_required: true, login_required: true }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try { process.stdout.write(`${JSON.stringify(installBundledPlugin())}\n`) }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Plugin installation failed'}\n`); process.exitCode = 1 }
}
