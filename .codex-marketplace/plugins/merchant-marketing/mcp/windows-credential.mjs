import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const WINDOWS_CREDENTIAL_TARGET = 'com.storenova.merchant-mcp'
const invalid = () => { throw new Error('MCP_WINDOWS_CREDENTIAL_INVALID') }
const helperInvalid = () => { throw new Error('MCP_WINDOWS_CREDENTIAL_HELPER_INVALID') }

function binding(apiOrigin, workspaceId) {
  let origin
  try { origin = new URL(apiOrigin).origin } catch { invalid() }
  const workspace = workspaceId?.trim()
  if (!workspace || origin !== apiOrigin?.trim()) invalid()
  return { origin, workspace, account: createHash('sha256').update(`${origin}\n${workspace}`).digest('hex') }
}

export function assertWindowsCredentialHelperReady(helper = fileURLToPath(new URL('../windows/StoreNovaCredentialHelper.exe', import.meta.url))) {
  if (process.platform !== 'win32') helperInvalid()
  try { accessSync(helper, constants.X_OK) } catch { helperInvalid() }
  return helper
}

export function runWindowsCredentialHelper(request) {
  const helper = assertWindowsCredentialHelperReady()
  const result = spawnSync(helper, [], { input: JSON.stringify(request), encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 2_000, maxBuffer: 1024 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) helperInvalid()
  return result.stdout
}

export function createWindowsInstallationIdentityStore(options = {}) {
  const runHelper = options.runHelper ?? runWindowsCredentialHelper
  const request = { target: 'com.storenova.installation-identity', account: 'current-installation' }
  return {
    load() {
      try { return JSON.parse(String(runHelper({ operation: 'read', ...request })).trim()) }
      catch { return undefined }
    },
    save(identity) { runHelper({ operation: 'write', ...request, data: JSON.stringify(identity) }) },
  }
}

export function writeWindowsCredential({ apiOrigin, workspaceId }, bundle, options = {}) {
  const { origin, workspace, account } = binding(apiOrigin, workspaceId)
  const record = { schema_version: '1', api_origin: origin, workspace_id: workspace,
    access_token: bundle?.access_token?.trim(), refresh_token: bundle?.refresh_token?.trim(), expires_at: bundle?.expires_at?.trim() }
  if (bundle?.schema_version !== '1' || bundle.api_origin !== origin || bundle.workspace_id !== workspace
    || !record.access_token || !record.refresh_token || !record.expires_at || !Number.isFinite(Date.parse(record.expires_at))) invalid()
  try { (options.runHelper ?? runWindowsCredentialHelper)({ operation: 'write', target: WINDOWS_CREDENTIAL_TARGET, account, data: JSON.stringify(record) }) }
  catch (error) { if (error?.message === 'MCP_WINDOWS_CREDENTIAL_HELPER_INVALID') throw error; invalid() }
}

export function readWindowsCredential({ apiOrigin, workspaceId }, options = {}) {
  const { origin, workspace, account } = binding(apiOrigin, workspaceId)
  let record
  try { record = JSON.parse(String((options.runHelper ?? runWindowsCredentialHelper)({ operation: 'read', target: WINDOWS_CREDENTIAL_TARGET, account })).trim()) }
  catch (error) { if (error?.message === 'MCP_WINDOWS_CREDENTIAL_HELPER_INVALID') throw error; invalid() }
  if (record?.schema_version !== '1' || record.api_origin !== origin || record.workspace_id !== workspace
    || !record.access_token?.trim() || !record.refresh_token?.trim() || !Number.isFinite(Date.parse(record.expires_at))) invalid()
  return record
}
