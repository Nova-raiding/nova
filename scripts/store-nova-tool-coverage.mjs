import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import readline from 'node:readline'

const bridge = process.env.STORE_NOVA_BRIDGE || '/Users/lixiaomei/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20260929213938/mcp/bridge.mjs'
const output = resolve(process.argv[2] || 'docs/qa/evidence/2026-09-29-chatgpt-app/tool-coverage-116.json')
const child = spawn(process.execPath, [bridge], {
  cwd: dirname(dirname(bridge)),
  env: {
    ...process.env,
    DEPLOY_ENV: 'local_desktop',
    MERCHANT_MCP_BASE_URL: process.env.MERCHANT_MCP_BASE_URL || 'https://yxsona.com',
    MERCHANT_WORKSPACE_ID: process.env.MERCHANT_WORKSPACE_ID || 'ws_guirenniaoniao',
    MERCHANT_MCP_TOKEN_SOURCE: process.env.MERCHANT_MCP_TOKEN_SOURCE || 'keychain',
    MERCHANT_STRICT_AUTH: 'true',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const lines = readline.createInterface({ input: child.stdout })
const pending = new Map()
let stderr = ''
child.stderr.on('data', data => { stderr += String(data).slice(0, 2000) })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const waiter = pending.get(message.id)
  if (waiter) { pending.delete(message.id); waiter(message) }
})
let sequence = 0
function rpc(method, params = {}) {
  const id = ++sequence
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout:${method}`)) }, 30_000)
    pending.set(id, value => { clearTimeout(timer); accept(value) })
  })
}
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
function safeSummary(response) {
  if (response?.error) return { transport_error: response.error.code, message: String(response.error.message || '').slice(0, 240) }
  const result = response?.result || {}
  const structured = result.structuredContent
  const value = structured && typeof structured === 'object' ? structured : {}
  const counts = {}
  for (const [key, item] of Object.entries(value)) if (Array.isArray(item)) counts[key] = item.length
  return {
    is_error: result.isError === true,
    code: typeof value.code === 'string' ? value.code : undefined,
    message: typeof value.message === 'string' ? value.message.slice(0, 240) : undefined,
    counts,
    result_shape: Object.keys(value).sort(),
    response_digest: digest(JSON.stringify(response)),
  }
}
function structured(response) { return response?.result?.structuredContent || {} }
function findValues(value, wanted, found = []) {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) { for (const item of value) findValues(item, wanted, found); return found }
  for (const [key, item] of Object.entries(value)) {
    if (wanted.includes(key) && typeof item === 'string' && item) found.push(item)
    else findValues(item, wanted, found)
  }
  return [...new Set(found)]
}
function writeCategory(name, tool) {
  const destructive = tool.annotations?.destructiveHint === true
  if (destructive || /delete|deactivate|disable/.test(name)) return 'delete_or_destructive'
  if (/payment|recharge|order\.create/.test(name)) return 'payment_or_purchase'
  if (/approve|review\.decide|facts\.confirm|rights\.update|interactive\.confirm|select$|\.accept$|learning\.confirm/.test(name)) return 'approval_or_confirmation'
  if (/publish/.test(name)) return 'publish'
  if (/export/.test(name)) return 'export_or_data_request'
  if (/generate|image\.edit|creative\.(brief|preview)|parse/.test(name)) return 'generation_or_model_write'
  return 'safe_draft_or_internal_write'
}

const initialized = await rpc('initialize', {})
const listed = await rpc('tools/list', {})
const tools = listed.result.tools
const results = new Map()
const raw = new Map()
const invoke = async (name, args) => {
  try {
    const response = await rpc('tools/call', { name, arguments: args })
    raw.set(name, response)
    results.set(name, { executed: true, arguments_shape: Object.keys(args).sort(), ...safeSummary(response) })
  } catch (error) {
    results.set(name, { executed: true, defect: true, message: String(error?.message || error) })
  }
}

// Run every zero-argument read operation first so later calls can use real IDs.
for (const tool of tools) {
  if (tool.annotations?.readOnlyHint !== true) continue
  if ((tool.inputSchema?.required || []).length === 0) await invoke(tool.name, {})
}

const allRaw = () => [...raw.values()].map(structured)
const ids = keys => [...new Set(allRaw().flatMap(value => findValues(value, keys)))]
const dependent = {
  'campaign.batch.get': ['campaign_id', () => ids(['campaign_id'])[0]],
  'commercial.order.payment.get': ['order_id', () => ids(['order_id'])[0]],
  'workspace.data.export.get': ['request_id', () => ids(['request_id', 'export_request_id'])[0]],
  'billing.recharge.get': ['order_id', () => ids(['order_id'])[0]],
  'rule.history': ['pack_id', () => ids(['pack_id', 'rule_pack_id'])[0]],
  'task.resume': ['task_id', () => ids(['task_id'])[0]],
  'task.timeline': ['task_id', () => ids(['task_id'])[0]],
  'feedback.list': ['task_id', () => ids(['task_id'])[0]],
  'content.versions': ['task_id', () => ids(['task_id'])[0]],
  'generation.get': ['job_id', () => ids(['job_id', 'generation_job_id'])[0]],
  'catalog.image.get': ['job_id', () => ids(['image_job_id', 'job_id'])[0]],
  'content.diff': ['content_version_id', () => ids(['content_version_id', 'version_id'])[0]],
}
for (const [name, [key, getter]] of Object.entries(dependent)) {
  if (results.has(name)) continue
  const value = getter()
  if (value) await invoke(name, { [key]: value })
  else results.set(name, { executed: false, status: 'not_applicable', reason: `no_real_${key}_returned_by_safe_lists` })
}
// content.versions may reveal a version or generation job; retry those dependencies once.
for (const name of ['generation.get', 'content.diff', 'catalog.image.get']) {
  if (results.get(name)?.executed) continue
  const [key, getter] = dependent[name]
  const value = getter()
  if (value) await invoke(name, { [key]: value })
}

const rows = tools.map(tool => {
  const readOnly = tool.annotations?.readOnlyHint === true
  const run = results.get(tool.name)
  let status
  if (readOnly) {
    if (!run?.executed) status = 'not_applicable'
    else if (run.defect || run.transport_error) status = 'defect'
    else if (!run.is_error) status = 'pass'
    else if (/REQUIRED|FORBIDDEN|NOT_FOUND|UNAVAILABLE|BLOCKED|NOT_READY|EMPTY|DISABLED|EXPIRED|INVALID/.test(run.code || '')) status = 'expected_gate'
    else status = 'blocked'
  } else status = 'not_executed_by_safety_policy'
  return {
    name: tool.name,
    category: readOnly ? 'read_only' : writeCategory(tool.name, tool),
    read_only: readOnly,
    destructive: tool.annotations?.destructiveHint === true,
    required_arguments: tool.inputSchema?.required || [],
    status,
    ...(run || { executed: false, reason: 'write_or_external_side_effect_not_authorized_for_coverage_probe' }),
  }
})
const tally = rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc }, {})
const document = {
  schema_version: 'store-nova-tool-coverage.v1',
  generated_at: new Date().toISOString(),
  plugin_version: initialized.result?.serverInfo?.version,
  bridge_sha256: createHash('sha256').update(await (await import('node:fs/promises')).readFile(bridge)).digest('hex'),
  workspace_ref_sha256_16: digest(process.env.MERCHANT_WORKSPACE_ID || 'ws_guirenniaoniao'),
  policy: 'Execute all declared read-only tools with real identifiers discovered from safe list calls. Do not execute approvals, publish, purchase/payment, generation, export requests, deletion, or state-changing tools.',
  tool_count: tools.length,
  tally,
  stderr_present: Boolean(stderr.trim()),
  tools: rows,
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
await chmod(output, 0o600)
child.kill()
console.log(JSON.stringify({ output, tool_count: tools.length, tally }, null, 2))
