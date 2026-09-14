import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MODEL_ENV_NAMES = [
  'MODEL_RELAY_BASE_URL',
  'MODEL_RELAY_ALLOWED_HOSTS',
  'AI_MODEL',
  'AI_THINKING_MODE',
  'AI_TIMEOUT_MS',
  'IMAGE_MODEL',
  'IMAGE_EDIT_MODEL',
  'IMAGE_RESPONSE_FORMAT',
  'IMAGE_TIMEOUT_MS',
  'OCR_MODEL',
  'VIDEO_MODEL',
  'VIDEO_IMAGE_MODEL',
  'AI_VIDEO_MODEL',
  'VIDEO_DURATION_SECONDS',
  'VIDEO_RESOLUTION',
  'VIDEO_GENERATION_PATH',
  'VIDEO_STATUS_PATH',
  'VIDEO_REQUEST_FORMAT',
  'MODEL_RELAY_PRICING_DERIVATION_ENABLED',
  'MODEL_RELAY_PRICING_GROUP',
  'MODEL_RELAY_TEXT_PRICING_GROUP',
  'MODEL_RELAY_OCR_PRICING_GROUP',
  'MODEL_RELAY_IMAGE_PRICING_GROUP',
  'MODEL_RELAY_IMAGE_EDIT_PRICING_GROUP',
  'MODEL_RELAY_VIDEO_PRICING_GROUP',
  'MODEL_RELAY_VIDEO_PRICING_OVERRIDES',
  'MODEL_RELAY_COST_EVIDENCE',
  'MODEL_RELAY_TEXT_COST_EVIDENCE',
  'MODEL_RELAY_IMAGE_COST_EVIDENCE',
  'MODEL_RELAY_IMAGE_EDIT_COST_EVIDENCE',
  'MODEL_RELAY_OCR_COST_EVIDENCE',
  'MODEL_RELAY_VIDEO_COST_EVIDENCE',
  'MODEL_RELAY_EVIDENCE_PATH',
  'MODEL_RPM_LIMIT',
  'MODEL_TPM_LIMIT',
  'MODEL_DAILY_CNY_LIMIT',
  'MODEL_MAX_TASK_COST_CNY',
  'MODEL_COST_ESTIMATE_VERSION',
  'MODEL_TEXT_MAX_REQUEST_CNY',
  'MODEL_IMAGE_MAX_REQUEST_CNY',
  'MODEL_IMAGE_EDIT_MAX_REQUEST_CNY',
  'MODEL_OCR_MAX_REQUEST_CNY',
  'MODEL_VIDEO_MAX_REQUEST_CNY',
]

export function parseEnvFile(text) {
  const values = new Map()
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = rawLine.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u)
    if (!match) continue
    let value = match[2] ?? ''
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) value = value.slice(1, -1)
    values.set(match[1], value)
  }
  return values
}

export function applyModelEnvironment(target, envText) {
  const configured = parseEnvFile(envText)
  for (const name of MODEL_ENV_NAMES) {
    if (target[name]?.trim()) continue
    const value = configured.get(name)?.trim()
    if (value) target[name] = value
  }
  return target
}

export function readRelayKey(target = process.env) {
  const existing = target.MODEL_RELAY_API_KEY?.trim()
  if (existing) return existing
  const account = target.USER?.trim()
  if (!account) throw new Error('USER is required to read the model relay credential')
  try {
    const value = execFileSync('/usr/bin/security', [
      'find-generic-password',
      '-a', account,
      '-s', 'com.merchant.codex.model-relay',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (value) return value
  } catch {
    // The caller emits a stable, non-secret startup error below.
  }
  throw new Error('model relay credential is unavailable')
}

export async function startApi() {
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const envFile = resolve(projectDir, '.env')
  if (existsSync(envFile)) applyModelEnvironment(process.env, readFileSync(envFile, 'utf8'))
  process.env.MODEL_RELAY_API_KEY = readRelayKey(process.env)
  await import(pathToFileURL(resolve(projectDir, 'apps/api/src/server.ts')).href)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startApi()
}
