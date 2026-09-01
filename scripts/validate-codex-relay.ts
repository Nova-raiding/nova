import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export type RelayEnvironment = Record<string, string | undefined>
export interface CodexRelayValidationResult { errors: string[]; provider?: string; model?: string; envKey?: string; hostBaseUrl?: string; businessBaseUrl?: string; subscriptionAuth?: boolean }

const LEGACY = ['AI_BASE_URL', 'IMAGE_BASE_URL', 'VIDEO_BASE_URL', 'AI_API_KEY', 'IMAGE_API_KEY', 'VIDEO_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const
const BUSINESS_MODELS = ['AI_MODEL', 'IMAGE_MODEL', 'IMAGE_EDIT_MODEL', 'OCR_MODEL', 'VIDEO_MODEL'] as const

function field(text: string, key: string) { return text.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, 'mu'))?.[1]?.trim() }
function regexLiteral(input: string) { return input.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
function placeholder(input: string | undefined) { return !input || /REPLACE_WITH|YOUR_|你的|由.+注入|\$\{[^}]+\}/u.test(input) }
function https(input: string, label: string, errors: string[]) {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:') errors.push(`${label} 必须使用 HTTPS`)
    if (url.username || url.password || url.search || url.hash) errors.push(`${label} 不得包含用户名、密码、查询参数或 fragment`)
    return url
  } catch { errors.push(`${label} 不是合法 URL`); return undefined }
}

export function validateCodexRelay(config: string, env: RelayEnvironment = process.env): CodexRelayValidationResult {
  const errors: string[] = []
  if (!config.trim()) errors.push('Codex 用户配置不存在或为空')
  const hasHostOverride = /^\s*(?:model_provider|model)\s*=/mu.test(config)
  const provider = field(config, 'model_provider')
  const model = field(config, 'model')
  const section = provider ? config.match(new RegExp(`\\[model_providers\\.${regexLiteral(provider)}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'u'))?.[1] ?? '' : ''
  const baseUrl = field(section, 'base_url')
  const envKey = field(section, 'env_key')
  if (hasHostOverride) {
    if (placeholder(provider)) errors.push('Codex 配置缺少有效的 model_provider')
    if (placeholder(model)) errors.push('Codex 配置缺少有效的 host model')
    if (provider && !section) errors.push(`Codex 配置缺少 model_providers.${provider} section`)
    if (placeholder(baseUrl)) errors.push('Codex host relay 缺少有效的 base_url')
    else https(baseUrl!, 'Codex host relay base_url', errors)
    if (field(section, 'wire_api') !== 'responses') errors.push('Codex host relay 必须配置 wire_api = "responses"')
    if (placeholder(envKey) || !/^[A-Z][A-Z0-9_]*$/u.test(envKey ?? '')) errors.push('Codex host relay 缺少有效的 env_key（必须是环境变量名）')
    else if (placeholder(env[envKey!])) errors.push(`Codex host relay 环境变量未注入：${envKey}`)
  }

  const businessBaseUrl = env.MODEL_RELAY_BASE_URL?.trim()
  if (placeholder(businessBaseUrl)) errors.push('业务模型 relay 缺少有效的 MODEL_RELAY_BASE_URL')
  else https(businessBaseUrl!, '业务模型 relay MODEL_RELAY_BASE_URL', errors)
  if (placeholder(env.MODEL_RELAY_API_KEY)) errors.push('业务模型 relay 缺少 MODEL_RELAY_API_KEY')
  for (const variable of BUSINESS_MODELS) if (placeholder(env[variable]?.trim())) errors.push(`业务模型 relay 缺少有效的 ${variable}`)
  for (const variable of LEGACY) if (env[variable]?.trim()) errors.push(`检测到不允许的直连模型配置：${variable}；请移除并仅使用 MODEL_RELAY_*`)
  return { errors, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(envKey ? { envKey } : {}), ...(baseUrl ? { hostBaseUrl: baseUrl } : {}), businessBaseUrl, subscriptionAuth: !hasHostOverride }
}

export function runCodexRelayValidation(configPath: string, env: RelayEnvironment = process.env) {
  const exists = existsSync(configPath)
  const result = validateCodexRelay(exists ? readFileSync(configPath, 'utf8') : '', env)
  if (!exists) result.errors.unshift(`Codex 用户配置不存在：${configPath}`)
  return result
}

function objectEntries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)) : []
}

function supportsResponses(entry: Record<string, unknown>) {
  const endpointTypes = entry.supported_endpoint_types
  return Array.isArray(endpointTypes) && endpointTypes.includes('openai-response')
}

export async function probeCodexRelayCatalog(
  result: CodexRelayValidationResult,
  env: RelayEnvironment = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (result.errors.length || !result.hostBaseUrl || !result.envKey || !result.model) return result
  const secret = env[result.envKey]?.trim()
  if (!secret) return result
  try {
    const endpoint = `${result.hostBaseUrl.replace(/\/+$/u, '')}/models`
    const response = await fetcher(endpoint, {
      headers: { accept: 'application/json', authorization: `Bearer ${secret}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    if (!response.ok) {
      result.errors.push(`Codex host relay /models 返回 HTTP ${response.status}`)
      return result
    }
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
      result.errors.push('Codex host relay /models 响应超过 2MB 安全上限')
      return result
    }
    let payload: unknown
    try { payload = JSON.parse(text) } catch {
      result.errors.push('Codex host relay /models 未返回合法 JSON')
      return result
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      result.errors.push('Codex host relay /models 返回的目录不是对象')
      return result
    }
    const catalog = payload as Record<string, unknown>
    if (!Array.isArray(catalog.data)) result.errors.push('Codex host relay /models 缺少 OpenAI data 数组')
    // Codex App 0.151 dynamically refreshes the provider catalog from this
    // additional field. A relay can satisfy the public OpenAI data[] contract
    // yet still leave the desktop app on a stale cross-provider model cache.
    if (!Array.isArray(catalog.models)) result.errors.push('Codex host relay /models 与当前 Codex App 目录契约不兼容：缺少顶层 models 数组')
    const openAiModel = objectEntries(catalog.data).find(entry => entry.id === result.model)
    const codexModel = objectEntries(catalog.models).find(entry => entry.slug === result.model)
    if (!openAiModel) result.errors.push(`Codex host relay OpenAI data[] 未声明当前 host model：${result.model}`)
    else if (!supportsResponses(openAiModel)) result.errors.push(`Codex host relay 当前 host model 未声明 openai-response 能力：${result.model}`)
    if (!codexModel) result.errors.push(`Codex host relay Codex models[] 未声明当前 host model slug：${result.model}`)
  } catch (error) {
    result.errors.push(`Codex host relay /models 探测失败：${error instanceof Error && error.name === 'TimeoutError' ? '请求超时' : '连接失败'}`)
  }
  return result
}

function readDotEnv(path: string): RelayEnvironment {
  if (!existsSync(path)) return {}
  const values: RelayEnvironment = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^\s*(MODEL_RELAY_BASE_URL|MODEL_RELAY_API_KEY|AI_MODEL|IMAGE_MODEL|IMAGE_EDIT_MODEL|OCR_MODEL|VIDEO_MODEL)\s*=\s*(.*)\s*$/u)
    if (!match) continue
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/u, '$2')
    if (value) values[match[1]!] = value
  }
  return values
}

function readKeychainSecret(service: string): string | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    const value = execFileSync('/usr/bin/security', ['find-generic-password', '-a', process.env.USER ?? '', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return value || undefined
  } catch { return undefined }
}

function resolveCliEnvironment(): RelayEnvironment {
  const local = readDotEnv(resolve(process.cwd(), '.env'))
  const merged: RelayEnvironment = { ...local, ...process.env }
  // The host Codex provider uses the env_key declared in config.toml. The API
  // launch script already reads this Keychain item; validation must use the
  // same source so a key configured in another desktop tab is not mistaken for
  // a missing shell variable. Existing process variables always win.
  if (!merged.WORMHOLE_API_KEY) {
    const key = readKeychainSecret('com.merchant.codex.model-relay')
    if (key) merged.WORMHOLE_API_KEY = key
  }
  return merged
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const path = resolve(process.env.CODEX_CONFIG_PATH?.trim() || `${homedir()}/.codex/config.toml`)
  const environment = resolveCliEnvironment()
  const result = await probeCodexRelayCatalog(runCodexRelayValidation(path, environment), environment)
  if (result.errors.length) {
    console.error('codex relay validation failed')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else if (result.subscriptionAuth) console.log(`codex relay ready: host_auth=chatgpt_subscription business_relay=${new URL(result.businessBaseUrl!).host}`)
  else console.log(`codex relay ready: host_provider=${result.provider} host_endpoint=${new URL(result.hostBaseUrl!).host} business_relay=${new URL(result.businessBaseUrl!).host}`)
}
