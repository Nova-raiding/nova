#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fixture = value => typeof value === 'string' && /(?:fixture|demo|example\.test|local-only)/iu.test(value)
const noFixture = value => !fixture(value) && (!Array.isArray(value) || value.every(noFixture)) && (!object(value) || Object.values(value).every(noFixture))
const fail = reason => { throw new Error(reason) }

export function configFromEnv(env) {
  const base = env.OPS_SMOKE_API_BASE_URL?.trim()
  const workspace = env.OPS_SMOKE_WORKSPACE_ID?.trim()
  const workspaceActor = env.OPS_SMOKE_EXPECT_WORKSPACE_ACTOR_ID?.trim()
  const platformActor = env.OPS_SMOKE_EXPECT_PLATFORM_ACTOR_ID?.trim()
  const deniedWorkspace = env.OPS_SMOKE_DENIED_WORKSPACE_ID?.trim()
  const workspaceCredential = env.OPS_SMOKE_WORKSPACE_COOKIE?.trim() || env.OPS_SMOKE_WORKSPACE_TOKEN?.trim()
  const platformCredential = env.OPS_SMOKE_PLATFORM_COOKIE?.trim() || env.OPS_SMOKE_PLATFORM_TOKEN?.trim()
  if (!base || !workspace || !workspaceActor || !platformActor || !workspaceCredential || !platformCredential) fail('missing OPS_SMOKE_API_BASE_URL, WORKSPACE_ID, both EXPECT_*_ACTOR_ID values, and both authenticated workbench credentials')
  if (env.OPS_SMOKE_WORKSPACE_COOKIE && env.OPS_SMOKE_WORKSPACE_TOKEN) fail('workspace credential must use either cookie or bearer')
  if (env.OPS_SMOKE_PLATFORM_COOKIE && env.OPS_SMOKE_PLATFORM_TOKEN) fail('platform credential must use either cookie or bearer')
  if ([workspace, workspaceActor, platformActor, ...(deniedWorkspace ? [deniedWorkspace] : [])].some(value => !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value))) fail('workspace or actor identifier is invalid')
  if (deniedWorkspace === workspace) fail('denied workspace must differ from authorized workspace')
  let url
  try { url = new URL(base) } catch { fail('OPS_SMOKE_API_BASE_URL must be an absolute URL') }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) fail('API base must be HTTPS or loopback candidate and must contain no credentials/query')
  return { base: url.href.replace(/\/$/u, ''), workspace, workspaceActor, platformActor, deniedWorkspace, workspaceAuth: env.OPS_SMOKE_WORKSPACE_COOKIE ? { cookie: workspaceCredential } : { token: workspaceCredential }, platformAuth: env.OPS_SMOKE_PLATFORM_COOKIE ? { cookie: platformCredential } : { token: platformCredential } }
}

export async function runSmoke(config, fetcher = fetch) {
  const checks = []
  async function call(workbench, method, params = {}) {
    const auth = workbench === 'workspace' ? config.workspaceAuth : config.platformAuth
    const headers = { 'content-type': 'application/json', 'x-ops-workbench': workbench }
    if (workbench === 'workspace') headers['x-workspace-id'] = config.workspace
    if (auth.cookie) headers.cookie = auth.cookie
    else headers.authorization = `Bearer ${auth.token}`
    const id = `ops-smoke-${checks.length + 1}`
    const response = await fetcher(`${config.base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (response.status !== 200) fail(`${method}: HTTP ${response.status}`)
    const raw = await response.text()
    if (raw.length > 1024 * 1024) fail(`${method}: response too large`)
    let envelope
    try { envelope = JSON.parse(raw) } catch { fail(`${method}: invalid JSON`) }
    if (!object(envelope) || envelope.error || envelope.data?.error) fail(`${method}: MCP error`)
    const data = object(envelope.data) && Object.hasOwn(envelope.data, 'result') ? envelope.data.result : envelope.result
    if (data === undefined || !noFixture(data)) fail(`${method}: missing result or fixture marker`)
    checks.push(method)
    return data
  }
  const ws = await call('workspace', 'ops.session')
  if (!object(ws) || ws.schema_version !== 2 || ws.workbench !== 'workspace' || ws.workspace_id !== config.workspace || ws.actor_id !== config.workspaceActor || ws.workspace_granted !== true || !Array.isArray(ws.roles) || !Array.isArray(ws.capabilities) || ws.roles.length === 0 || ws.identity_id === null || ws.session_id === null) fail('workspace session lacks authenticated actor/tenant/permission provenance')
  const members = await call('workspace', 'ops.members.list', { offset: '0', limit: '20' })
  if (!object(members) || !Array.isArray(members.items) || members.items.some(row => !object(row) || row.workspaceId !== config.workspace) || !Number.isInteger(members.total)) fail('members page lacks tenant-scoped backend rows')
  const billing = await call('workspace', 'billing.status')
  if (!object(billing) || billing.schema_version !== 'commercial.billing-status.v2' || billing.workspace_id !== config.workspace || !object(billing.viewer) || !object(billing.model_access)) fail('billing response lacks tenant-scoped ledger contract')
  const rules = await call('workspace', 'knowledge.rule.list')
  if (!Array.isArray(rules) || rules.some(row => !object(row) || row.workspaceId !== config.workspace)) fail('rules response lacks tenant-scoped backend rows')
  const audit = await call('workspace', 'ops.audit.list', { limit: '20' })
  if (!object(audit) || !Array.isArray(audit.records) || audit.records.some(row => !object(row) || (row.workspaceId !== undefined && row.workspaceId !== config.workspace))) fail('audit response lacks tenant-scoped backend rows')
  const platform = await call('platform', 'ops.session')
  if (!object(platform) || platform.schema_version !== 2 || platform.workbench !== 'platform' || platform.workspace_id !== null || platform.context_id !== 'platform:global' || platform.actor_id !== config.platformActor || !Array.isArray(platform.canonical_roles) || platform.canonical_roles.length === 0 || platform.identity_id === null || platform.session_id === null) fail('platform session lacks authenticated identity and permission provenance')
  const model = await call('platform', 'platform.model.status')
  if (!object(model) || model.ownership !== 'platform' || model.user_key_binding !== false || !object(model.relay) || !object(model.model_readiness) || !object(model.cost_evidence_by_modality) || !['text', 'image', 'image_edit', 'ocr', 'video'].every(kind => object(model.model_readiness[kind]) && typeof model.cost_evidence_by_modality[kind] === 'boolean')) fail('platform model response lacks five-modality relay/cost provenance')
  if (config.deniedWorkspace) {
    const auth = config.workspaceAuth
    const headers = { 'content-type': 'application/json', 'x-ops-workbench': 'workspace', 'x-workspace-id': config.deniedWorkspace }
    if (auth.cookie) headers.cookie = auth.cookie
    else headers.authorization = `Bearer ${auth.token}`
    const response = await fetcher(`${config.base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'ops-smoke-denied-scope', method: 'ops.members.list', params: { offset: '0', limit: '1' } }), redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (response.status !== 403 && response.status !== 404) fail('cross-tenant request was not explicitly rejected with HTTP 403/404')
    checks.push('ops.members.list:denied_scope')
  }
  return { status: 'pass', scope: config.workspace, checks }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runSmoke(configFromEnv(process.env)))) }
  catch (error) { console.error(`ops real-backend smoke blocked: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1 }
}
