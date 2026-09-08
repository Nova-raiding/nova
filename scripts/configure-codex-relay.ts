import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
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
    `name = ${tomlString('大麦中转站')}`,
    `base_url = ${tomlString(input.baseUrl.replace(/\/$/u, ''))}`,
    `env_key = ${tomlString(input.apiKeyEnv)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 4',
    'stream_max_retries = 5',
  ].join('\n')
  let content = input.existing.trim()
  const topLevel = (key: string, value: string) => {
    const pattern = new RegExp(`^${key}\\s*=.*$`, 'mu')
    const line = `${key} = ${tomlString(value)}`
    content = pattern.test(content) ? content.replace(pattern, line) : `${line}\n${content}`
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
    content = content.replace(/^\s*service_tier\s*=.*(?:\n|$)/mu, '')
  }
  const escapedProvider = input.provider.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const sectionPattern = new RegExp(`(?:^|\\n)\\[model_providers\\.${escapedProvider}\\][\\s\\S]*?(?=\\n\\[|$)`, 'u')
  content = sectionPattern.test(content)
    ? content.replace(sectionPattern, `\n${providerBlock}`)
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
  if (seed) {
    // models_cache.json contains fields that are meaningful only to Codex's
    // built-in providers (for example responses-lite and node-repl policy
    // switches).  Passing those fields through to a third-party model can
    // make the host reject the catalog or disconnect before response.completed.
    const {
      use_responses_lite: _useResponsesLite,
      base_instructions: _baseInstructions,
      tool_mode: _toolMode,
      input_modalities: _inputModalities,
      comp_hash: _compHash,
      effective_context_window_percent: _effectiveContextWindowPercent,
      multi_agent_version: _multiAgentVersion,
      supports_image_detail_original: _supportsImageDetailOriginal,
      supports_search_tool: _supportsSearchTool,
      node_repl_auto_review_required: _nodeReplAutoReviewRequired,
      node_repl_disabled: _nodeReplDisabled,
      ...compatibleSeed
    } = seed
    return {
      models: [{
        ...compatibleSeed,
        slug: model,
        display_name: `${model} (大麦中转)`,
        description: '大麦模型中转站的 Responses 兼容宿主模型。',
        // The relay catalog does not advertise priority service tiers.  Keep
        // the local descriptor honest so Codex does not request an unsupported
        // tier and fall back at runtime.
        service_tiers: [],
        additional_speed_tiers: [],
        experimental_supported_tools: [],
      }],
    }
  }
  return {
    models: [{
      slug: model,
      display_name: `${model} (大麦中转)`,
      description: '大麦模型中转站的 Responses 兼容宿主模型。',
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
      model_messages: { instructions_template: 'You are Codex. Use the configured tools and complete the user request.' },
    }],
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
    const existing = await readFile(configPath, 'utf8').catch(() => '')
    const rendered = renderCodexRelayConfig({ existing, provider, model, baseUrl, apiKeyEnv, catalogPath })
    const bundledCache = await readFile(resolve(homedir(), '.codex/models_cache.json'), 'utf8')
      .then(value => JSON.parse(value) as { models?: unknown[] })
      .catch(() => undefined)
    const cacheModels = Array.isArray(bundledCache?.models)
      ? bundledCache.models.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && Boolean((entry as Record<string, unknown>).model_messages))
      : []
    const seed = cacheModels.find(entry => entry.slug === 'gpt-5.6-luna') ?? cacheModels[0]
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
    await writeFile(configPath, rendered, { encoding: 'utf8', mode: 0o600 })
    await chmod(configPath, 0o600)
    await mkdir(dirname(catalogPath), { recursive: true, mode: 0o700 })
    await writeFile(catalogPath, `${JSON.stringify(renderCodexRelayCatalog(model, seed), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(catalogPath, 0o600)
    console.log(`Codex relay 配置已写入：${configPath}`)
    console.log(`provider=${provider} model=${model} endpoint=${new URL(baseUrl).host} catalog=${catalogPath}`)
    console.log(`请在当前 shell/密钥管理器注入 ${apiKeyEnv}，然后运行：pnpm run codex:relay:validate`)
  }
}
