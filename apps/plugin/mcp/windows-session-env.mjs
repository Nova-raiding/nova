import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

export const WINDOWS_SESSION_NAMES = Object.freeze([
  'MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID', 'MERCHANT_MCP_TOKEN_SOURCE',
  'MERCHANT_STRICT_AUTH', 'MERCHANT_ALLOW_FIXTURE_FALLBACK', 'MERCHANT_MCP_WRITE_ENABLED', 'DEPLOY_ENV',
])
const invalid = () => { throw new Error('MCP_WINDOWS_SESSION_CONFIGURATION_INVALID') }
const present = value => typeof value === 'string' && value.trim() !== ''

export function readWindowsUserSession(env = process.env, run = execFileSync) {
  // Absolute system executable and a fixed script: no PATH search or user input in PowerShell code.
  if (!/^[A-Za-z]:\\[^\r\n]+$/u.test(env.SystemRoot ?? '')) invalid()
  const executable = win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const names = WINDOWS_SESSION_NAMES.map(name => `'${name}'`).join(',')
  const script = `$ErrorActionPreference='Stop'; $result=@{}; foreach($name in @(${names})) { $result[$name]=[Environment]::GetEnvironmentVariable($name,'User') }; $result | ConvertTo-Json -Compress`
  try {
    return JSON.parse(run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000, maxBuffer: 16384,
    }).trim())
  } catch { invalid() } // Never expose child-process output or configuration values.
}

export function restoreWindowsSession(env = process.env, platform = process.platform, readUser = readWindowsUserSession) {
  if (platform !== 'win32' || env.NODE_ENV === 'test' || env.VITEST === 'true') return
  // An explicit alternative credential source belongs to the existing runtime
  // contract (including the install verifier); never mix in a desktop login.
  if (present(env.MERCHANT_MCP_TOKEN_SOURCE) && env.MERCHANT_MCP_TOKEN_SOURCE !== 'windows_credential_manager') return
  const missing = WINDOWS_SESSION_NAMES.filter(name => !present(env[name]))
  if (!missing.length) return
  let stored
  try { stored = readUser(env) } catch { invalid() }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)
    || Object.keys(stored).some(name => !WINDOWS_SESSION_NAMES.includes(name))) invalid()
  if (missing.some(name => stored[name] != null && typeof stored[name] !== 'string')) invalid()
  // First use has no saved login. Preserve tools/list and the bridge's existing
  // MCP_CONFIGURATION_REQUIRED response instead of terminating the process.
  if (!WINDOWS_SESSION_NAMES.some(name => present(stored[name]))) return
  const validators = {
    MERCHANT_MCP_BASE_URL: value => value === 'https://yxsona.com',
    MERCHANT_WORKSPACE_ID: value => /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(value),
    MERCHANT_MCP_TOKEN_SOURCE: value => value === 'windows_credential_manager',
    MERCHANT_STRICT_AUTH: value => value === 'true',
    MERCHANT_ALLOW_FIXTURE_FALLBACK: value => value === 'false',
    MERCHANT_MCP_WRITE_ENABLED: value => value === 'false',
    DEPLOY_ENV: value => value === 'local_desktop',
  }
  // Validate only recovered fields atomically. Explicit configuration remains
  // under the existing bridge validation, including legitimate dev settings.
  for (const name of missing) {
    if (typeof stored[name] !== 'string' || !validators[name](stored[name])) invalid()
  }
  for (const name of missing) env[name] = stored[name]
}
