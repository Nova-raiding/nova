#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(source, '.codex-plugin/plugin.json'), 'utf8'))
const runtime = resolve(source, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
if (!existsSync(runtime)) throw new Error('Bundled Node runtime is missing')
const agentsHome = resolve(process.env.AGENTS_HOME || resolve(homedir(), '.agents'))
const destination = resolve(homedir(), 'plugins', 'merchant-marketing')
const marketplacePath = resolve(agentsHome, 'plugins', 'marketplace.json')
const entry = { name: 'merchant-marketing', source: { source: 'local', path: './plugins/merchant-marketing' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }

const marketplace = existsSync(marketplacePath)
  ? JSON.parse(readFileSync(marketplacePath, 'utf8'))
  : { name: 'merchant-personal', interface: { displayName: 'Merchant Marketing' }, plugins: [] }
if (!marketplace || !Array.isArray(marketplace.plugins)) throw new Error('Existing personal plugin registry is invalid')
if (!/^[A-Za-z0-9_-]+$/u.test(marketplace.name ?? '')) throw new Error('Personal plugin registry name is invalid')
marketplace.plugins = [...marketplace.plugins.filter(plugin => plugin?.name !== 'merchant-marketing'), entry]
const codexHome = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'))
// ChatGPT resolves a local marketplace installation from the literal `local` cache slot.
const cache = resolve(codexHome, 'plugins', 'cache', marketplace.name, 'merchant-marketing', 'local')
if ([destination, cache].some(path => path === source || path.startsWith(`${source}${sep}`))) {
  throw new Error('Plugin install destination must be outside the extracted package')
}
const configPath = resolve(codexHome, 'config.toml')
const configSection = `[plugins."merchant-marketing@${marketplace.name}"]`
const oldConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
const oldRegistry = existsSync(marketplacePath) ? readFileSync(marketplacePath, 'utf8') : null
const lines = oldConfig.split('\n')
const sectionIndex = lines.findIndex(line => line.trim() === configSection)
if (sectionIndex !== -1) {
  const end = lines.findIndex((line, index) => index > sectionIndex && /^\[/u.test(line.trim()))
  const sectionEnd = end === -1 ? lines.length : end
  const enabled = lines.findIndex((line, index) => index > sectionIndex && index < sectionEnd && /^enabled\s*=/u.test(line.trim()))
  if (enabled === -1) lines.splice(sectionIndex + 1, 0, 'enabled = true')
  else lines[enabled] = 'enabled = true'
} else lines.push(configSection, 'enabled = true', '')
const nextConfig = lines.join('\n')

mkdirSync(dirname(destination), { recursive: true })
mkdirSync(dirname(marketplacePath), { recursive: true })
mkdirSync(dirname(cache), { recursive: true })
mkdirSync(dirname(configPath), { recursive: true })
if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error('Plugin destination must not be a symlink')
if (existsSync(cache) && lstatSync(cache).isSymbolicLink()) throw new Error('Plugin cache must not be a symlink')
const staged = mkdtempSync(resolve(dirname(destination), '.merchant-marketing-install-'))
const stagedCache = mkdtempSync(resolve(dirname(cache), '.merchant-marketing-cache-'))
const temporaryRegistry = resolve(dirname(marketplacePath), `.marketplace-${process.pid}.tmp`)
const temporaryConfig = resolve(dirname(configPath), `.config-${process.pid}.tmp`)
const copyPluginFile = path => !path.split(/[\\/]/u).includes('.agents')
try {
  cpSync(source, staged, { recursive: true, filter: copyPluginFile })
  cpSync(source, stagedCache, { recursive: true, filter: copyPluginFile })
  // The copied runtime must be able to start without the developer's PATH.
  if (!existsSync(resolve(staged, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))) throw new Error('Runtime copy failed')
  const previous = existsSync(destination) ? resolve(dirname(destination), `.merchant-marketing-previous-${process.pid}`) : null
  const previousCache = existsSync(cache) ? resolve(dirname(cache), `.merchant-marketing-cache-previous-${process.pid}`) : null
  let movedSource = false
  let movedCache = false
  let installedSource = false
  let installedCache = false
  try {
    if (previous) { renameSync(destination, previous); movedSource = true }
    if (previousCache) { renameSync(cache, previousCache); movedCache = true }
    renameSync(staged, destination)
    installedSource = true
    renameSync(stagedCache, cache)
    installedCache = true
    writeFileSync(temporaryRegistry, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryRegistry, marketplacePath)
    writeFileSync(temporaryConfig, nextConfig, { mode: 0o600 })
    renameSync(temporaryConfig, configPath)
  } catch (error) {
    if (installedSource) rmSync(destination, { recursive: true, force: true })
    if (movedSource) renameSync(previous, destination)
    if (installedCache) rmSync(cache, { recursive: true, force: true })
    if (movedCache) renameSync(previousCache, cache)
    if (oldRegistry === null) { if (existsSync(marketplacePath)) rmSync(marketplacePath) }
    else writeFileSync(marketplacePath, oldRegistry)
    throw error
  }
  if (previous) rmSync(previous, { recursive: true, force: true })
  if (previousCache) rmSync(previousCache, { recursive: true, force: true })
  process.stdout.write(`${JSON.stringify({ ok: true, plugin: manifest.name, version: manifest.version,
    installed: cache, source: destination, registry: marketplacePath, restart_required: true, login_required: true })}\n`)
} finally {
  if (existsSync(staged)) rmSync(staged, { recursive: true, force: true })
  if (existsSync(stagedCache)) rmSync(stagedCache, { recursive: true, force: true })
  if (existsSync(temporaryRegistry)) rmSync(temporaryRegistry, { force: true })
  if (existsSync(temporaryConfig)) rmSync(temporaryConfig, { force: true })
}
