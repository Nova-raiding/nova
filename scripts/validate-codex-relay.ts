import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export type RelayEnvironment = Record<string, string | undefined>
export interface CodexRelayValidationResult { errors: string[]; provider?: string; hostBaseUrl?: string; businessBaseUrl?: string }

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
  const provider = field(config, 'model_provider')
  if (placeholder(provider)) errors.push('Codex 配置缺少有效的 model_provider')
  if (placeholder(field(config, 'model'))) errors.push('Codex 配置缺少有效的 host model')
  const section = provider ? config.match(new RegExp(`\\[model_providers\\.${regexLiteral(provider)}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'u'))?.[1] ?? '' : ''
  if (provider && !section) errors.push(`Codex 配置缺少 model_providers.${provider} section`)
  const baseUrl = field(section, 'base_url')
  if (placeholder(baseUrl)) errors.push('Codex host relay 缺少有效的 base_url')
  else https(baseUrl!, 'Codex host relay base_url', errors)
  if (field(section, 'wire_api') !== 'responses') errors.push('Codex host relay 必须配置 wire_api = "responses"')
  const envKey = field(section, 'env_key')
  if (placeholder(envKey) || !/^[A-Z][A-Z0-9_]*$/u.test(envKey ?? '')) errors.push('Codex host relay 缺少有效的 env_key（必须是环境变量名）')
  else if (placeholder(env[envKey!])) errors.push(`Codex host relay 环境变量未注入：${envKey}`)

  const businessBaseUrl = env.MODEL_RELAY_BASE_URL?.trim()
  if (placeholder(businessBaseUrl)) errors.push('业务模型 relay 缺少有效的 MODEL_RELAY_BASE_URL')
  else https(businessBaseUrl!, '业务模型 relay MODEL_RELAY_BASE_URL', errors)
  if (placeholder(env.MODEL_RELAY_API_KEY)) errors.push('业务模型 relay 缺少 MODEL_RELAY_API_KEY')
  for (const variable of BUSINESS_MODELS) if (placeholder(env[variable]?.trim())) errors.push(`业务模型 relay 缺少有效的 ${variable}`)
  for (const variable of LEGACY) if (env[variable]?.trim()) errors.push(`检测到不允许的直连模型配置：${variable}；请移除并仅使用 MODEL_RELAY_*`)
  return { errors, provider, hostBaseUrl: baseUrl, businessBaseUrl }
}

export function runCodexRelayValidation(configPath: string, env: RelayEnvironment = process.env) {
  const exists = existsSync(configPath)
  const result = validateCodexRelay(exists ? readFileSync(configPath, 'utf8') : '', env)
  if (!exists) result.errors.unshift(`Codex 用户配置不存在：${configPath}`)
  return result
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const path = resolve(process.env.CODEX_CONFIG_PATH?.trim() || `${homedir()}/.codex/config.toml`)
  const result = runCodexRelayValidation(path)
  if (result.errors.length) {
    console.error('codex relay validation failed')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else console.log(`codex relay ready: host_provider=${result.provider} host_endpoint=${new URL(result.hostBaseUrl!).host} business_relay=${new URL(result.businessBaseUrl!).host}`)
}
