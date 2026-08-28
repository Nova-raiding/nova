import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export interface CodexRelayConfigInput {
  existing: string
  provider: string
  model: string
  baseUrl: string
  apiKeyEnv: string
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
  const escapedProvider = input.provider.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const sectionPattern = new RegExp(`(?:^|\\n)\\[model_providers\\.${escapedProvider}\\][\\s\\S]*?(?=\\n\\[|$)`, 'u')
  content = sectionPattern.test(content)
    ? content.replace(sectionPattern, `\n${providerBlock}`)
    : `${content.replace(/\s*$/u, '')}\n\n${providerBlock}`
  return `${content.trim()}\n`
}

const configPath = resolve(process.env.CODEX_CONFIG_PATH?.trim() || `${homedir()}/.codex/config.toml`)
const baseUrl = process.env.CODEX_RELAY_BASE_URL?.trim()
const model = process.env.CODEX_RELAY_MODEL?.trim()
const provider = process.env.CODEX_RELAY_PROVIDER?.trim() || 'damai_relay'
const apiKeyEnv = process.env.CODEX_RELAY_API_KEY_ENV?.trim() || 'DAMAI_CODEX_RELAY_API_KEY'

if (process.argv[1]?.endsWith('configure-codex-relay.ts')) {
  if (!baseUrl || !model) {
    console.error('缺少 CODEX_RELAY_BASE_URL 或 CODEX_RELAY_MODEL；本命令不会使用示例值写入配置。')
    process.exitCode = 1
  } else {
    const existing = await readFile(configPath, 'utf8').catch(() => '')
    const rendered = renderCodexRelayConfig({ existing, provider, model, baseUrl, apiKeyEnv })
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
    await writeFile(configPath, rendered, { encoding: 'utf8', mode: 0o600 })
    await chmod(configPath, 0o600)
    console.log(`Codex relay 配置已写入：${configPath}`)
    console.log(`provider=${provider} model=${model} endpoint=${new URL(baseUrl).host}`)
    console.log(`请在当前 shell/密钥管理器注入 ${apiKeyEnv}，然后运行：pnpm run codex:relay:validate`)
  }
}
