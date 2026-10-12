import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface CodexRelayConfigInput {
  existing: string
  provider: string
  model: string
  baseUrl: string
  apiKeyEnv: string
  catalogPath?: string
}

function tomlString(value: string) {
  return JSON.stringify(value)
}

function assertSafe(value: string, label: string) {
  if (!value.trim() || value.includes('\n') || value.includes('\r')) throw new Error(`${label} 不能为空且不能包含换行符`)
  if (/REPLACE_WITH|YOUR_|你的|由.+注入|\$\{[^}]+\}/u.test(value)) throw new Error(`${label} 不能使用示例或占位值`)
}

export function renderCodexRelayConfig(input: CodexRelayConfigInput) {
  assertSafe(input.provider, 'provider')
  if (!/^[A-Za-z0-9_-]+$/u.test(input.provider)) throw new Error('provider 必须是字母、数字、下划线或连字符标识')
  assertSafe(input.model, 'model')
  assertSafe(input.apiKeyEnv, 'apiKeyEnv')
  let url: URL
  try { url = new URL(input.baseUrl) } catch { throw new Error('Codex relay base URL 不是合法 URL') }
  if (url.protocol !== 'https:') throw new Error('Codex relay base URL 必须使用 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('Codex relay base URL 不得包含用户名、密码、查询参数或 fragment')
  if (!/^[A-Z][A-Z0-9_]*$/u.test(input.apiKeyEnv)) throw new Error('apiKeyEnv 必须是环境变量名')
  const providerHeader = `[model_providers.${input.provider}]`
  const providerBlock = [
    providerHeader,
    `name = ${tomlString('Store Nova中转站')}`,
    `base_url = ${tomlString(input.baseUrl.replace(/\/$/u, ''))}`,
    `env_key = ${tomlString(input.apiKeyEnv)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 4',
    'stream_max_retries = 5',
  ].join('\n')
  const existing = input.existing.replace(/\r\n/gu, '\n')
  const sectionStart = existing.search(/^[ \t]*\[/mu)
  let root = sectionStart < 0 ? existing : existing.slice(0, sectionStart)
  const sections = sectionStart < 0 ? '' : existing.slice(sectionStart)
  // This deliberately small editor must not mistake multiline string contents for tables.
  if (/"""|'''/u.test(existing)) throw new Error('多行 TOML 字符串需要手工配置；未写入配置')
  const topLevel = (key: string, value: string) => {
    const pattern = new RegExp(`^[ \t]*${key}[ \t]*=.*$`, 'gmu')
    if ([...root.matchAll(pattern)].length > 1) throw new Error(`重复根配置键：${key}`)
    const line = `${key} = ${tomlString(value)}`
    root = root.replace(pattern, () => line)
    if (![...root.matchAll(pattern)].length) root = `${line}\n${root}`
  }
  topLevel('model', input.model)
  topLevel('model_provider', input.provider)
  if (input.catalogPath) {
    assertSafe(input.catalogPath, 'catalogPath')
    if (!isAbsolute(input.catalogPath)) throw new Error('catalogPath 必须是绝对路径')
    topLevel('model_catalog_json', input.catalogPath)
    // The relay-backed local catalog intentionally has no advertised service
    // tiers.  Retaining a host-wide `service_tier = "fast"`/`"priority"`
    // setting makes Codex emit a warning and can cause the request to be
    // routed with an unsupported tier.  Leave tier selection to the relay.
    root = root.replace(/^[ \t]*service_tier[ \t]*=.*(?:\n|$)/gmu, '')
  }
  let content = `${root.trimEnd()}\n${sections}`
  const escapedProvider = input.provider.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const sectionPattern = new RegExp(`(?:^|\\n)[ \t]*\\[model_providers\\.${escapedProvider}\\][ \t]*(?:#[^\\n]*)?(?=\\n|$)[\\s\\S]*?(?=\\n[ \t]*\\[|$)`, 'u')
  content = sectionPattern.test(content)
    ? content.replace(sectionPattern, () => `\n${providerBlock}`)
    : `${content.replace(/\s*$/u, '')}\n\n${providerBlock}`
  return `${content.trim()}\n`
}

/**
 * Codex's model manager expects a `models[]` mirror in addition to the
 * standard OpenAI `data[]` catalog.  Some compatible relays omit that mirror,
 * so the setup command pins a minimal local descriptor for the selected host
 * model.  Runtime requests still go through the configured relay and the
 * relay validator remains the source of truth for endpoint/auth readiness.
 */
export function renderCodexRelayCatalog(model: string, seed?: Record<string, unknown>) {
  assertSafe(model, 'model')
  // Explicit seed allowlist: host instruction templates only, never model routing or capabilities.
  const modelMessages = seed?.model_messages && typeof seed.model_messages === 'object' && !Array.isArray(seed.model_messages)
    ? seed.model_messages : { instructions_template: 'You are Codex. Use the configured tools and complete the user request.' }
  return {
    models: [{
      slug: model,
      display_name: `${model} (Store Nova中转)`,
      description: 'Store Nova模型中转站的 Responses 兼容宿主模型。',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: '快速响应' },
        { effort: 'medium', description: '平衡速度和推理' },
        { effort: 'high', description: '更深推理' },
      ],
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      include_skills_usage_instructions: true,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: true,
      default_reasoning_summary: 'none',
      support_verbosity: true,
      default_verbosity: 'low',
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text_and_image',
      truncation_policy: { mode: 'tokens', limit: 10000 },
      context_window: 128000,
      max_context_window: 128000,
      experimental_supported_tools: [],
      model_messages: modelMessages,
    }],
  }
}

/** Atomic per-file replacement, not a two-file transaction or a crash-recovery protocol. */
export async function commitCodexRelayFiles(input: { configPath: string; catalogPath: string; config: string; catalog: string }, renameFile = rename) {
  if (resolve(input.configPath) === resolve(input.catalogPath)) throw new Error('配置与 catalog 路径不能相同')
  JSON.parse(input.catalog)
  const previousCatalog = await readFile(input.catalogPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const staged: string[] = []
  const stage = async (path: string, value: string | Buffer) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    staged.push(temporary)
    try { await file.writeFile(value) } finally { await file.close() }
    return temporary
  }
  try {
    const catalogStage = await stage(input.catalogPath, input.catalog)
    const configStage = await stage(input.configPath, input.config)
    await renameFile(catalogStage, input.catalogPath)
    try {
      // Failed rename leaves old config untouched; restore the catalog it points to.
      await renameFile(configStage, input.configPath)
    } catch (error) {
      try {
        if (previousCatalog !== undefined) await renameFile(await stage(input.catalogPath, previousCatalog), input.catalogPath)
        else await unlink(input.catalogPath)
      } catch {
        throw new Error('配置提交失败且 catalog 恢复失败；请使用备份恢复后再重试')
      }
      throw error
    }
  } finally {
    await Promise.all(staged.map(path => unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })))
  }
}

const configPath = resolve(process.env.CODEX_CONFIG_PATH?.trim() || `${homedir()}/.codex/config.toml`)
const baseUrl = process.env.CODEX_RELAY_BASE_URL?.trim()
const model = process.env.CODEX_RELAY_MODEL?.trim()
const provider = process.env.CODEX_RELAY_PROVIDER?.trim() || 'damai_relay'
const apiKeyEnv = process.env.CODEX_RELAY_API_KEY_ENV?.trim() || 'DAMAI_CODEX_RELAY_API_KEY'
const catalogPath = resolve(process.env.CODEX_RELAY_MODEL_CATALOG_PATH?.trim() || `${homedir()}/.codex/merchant-marketing/model-catalog.json`)

if (process.argv[1]?.endsWith('configure-codex-relay.ts')) {
  if (!baseUrl || !model) {
    console.error('缺少 CODEX_RELAY_BASE_URL 或 CODEX_RELAY_MODEL；本命令不会使用示例值写入配置。')
    process.exitCode = 1
  } else {
    const existing = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
    const rendered = renderCodexRelayConfig({ existing, provider, model, baseUrl, apiKeyEnv, catalogPath })
    const bundledCache = await readFile(resolve(homedir(), '.codex/models_cache.json'), 'utf8')
      .then(value => JSON.parse(value) as { models?: unknown[] })
      .catch(() => undefined)
    const cacheModels = Array.isArray(bundledCache?.models)
      ? bundledCache.models.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && Boolean((entry as Record<string, unknown>).model_messages))
      : []
    const seed = cacheModels.find(entry => entry.slug === 'gpt-5.6-luna') ?? cacheModels[0]
    const catalog = `${JSON.stringify(renderCodexRelayCatalog(model, seed), null, 2)}\n`
    await commitCodexRelayFiles({ configPath, catalogPath, config: rendered, catalog })
    console.log(`Codex relay 配置已写入：${configPath}`)
    console.log(`provider=${provider} model=${model} endpoint=${new URL(baseUrl).host} catalog=${catalogPath}`)
    console.log(`请在当前 shell/密钥管理器注入 ${apiKeyEnv}，然后运行：pnpm run codex:relay:validate`)
  }
}
