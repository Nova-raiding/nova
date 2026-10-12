import { execFileSync } from 'node:child_process'

export const LAUNCHD_ENVIRONMENT_NAMES = Object.freeze([
  'NODE_ENV', 'DEPLOY_ENV', 'MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID',
  'MERCHANT_MCP_TOKEN', 'MERCHANT_MCP_REFRESH_TOKEN', 'MERCHANT_MCP_TOKEN_SOURCE', 'MERCHANT_STRICT_AUTH', 'MERCHANT_ALLOW_FIXTURE_FALLBACK',
  'MERCHANT_MCP_WRITE_ENABLED', 'MERCHANT_RULE_APPROVAL_TOKEN', 'MERCHANT_ARTIFACT_DIR',
  'MERCHANT_MCP_TIMEOUT_MS', 'MERCHANT_MCP_RETRY_ATTEMPTS', 'MERCHANT_MCP_RETRY_DELAY_MS',
  'MERCHANT_ASSET_RESOURCE_DOMAINS', 'MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES',
])

export function launchctlExecutable(platform = process.platform) {
  return platform === 'darwin' ? '/bin/launchctl' : 'launchctl'
}

function isMissingEnvironmentValue(value) {
  return typeof value !== 'string' || !value.trim() || /^\$\{[^}]+\}$/u.test(value.trim())
}

/** Restore only the bridge's allowlisted settings from the current macOS user's launchd session. */
export function restoreLaunchdEnvironment({
  environment = process.env,
  platform = process.platform,
  execFileSync: run = execFileSync,
} = {}) {
  if (platform !== 'darwin' || environment.NODE_ENV === 'test' || environment.VITEST === 'true') return []

  const restored = []
  const explicitEnvironmentCredential = isMissingEnvironmentValue(environment.MERCHANT_MCP_TOKEN_SOURCE)
    && !isMissingEnvironmentValue(environment.MERCHANT_MCP_TOKEN)
  for (const name of LAUNCHD_ENVIRONMENT_NAMES) {
    // An explicit token without a source uses environment authentication. A
    // later desktop login must not silently switch it to a managed store.
    if (explicitEnvironmentCredential && name === 'MERCHANT_MCP_TOKEN_SOURCE') continue
    if (!isMissingEnvironmentValue(environment[name])) continue
    try {
      const value = run(launchctlExecutable(platform), ['getenv', name], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
      }).trim()
      if (value && !/^\$\{[^}]+\}$/u.test(value)) {
        environment[name] = value
        restored.push(name)
      }
    } catch {
      // The normal transport validation reports missing configuration without exposing launchd diagnostics.
    }
  }
  return restored
}
