import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const socket = 'unix:///Users/lixiaomei/.colima/default/docker.sock'
const dockerArgs = ['--host', socket]
const prior = JSON.parse(readFileSync('artifacts/local-worker-sync/run-20260915-1410/rollout-result.json'))
const base = '/Users/lixiaomei/Desktop/code/codexSkills/infra/local/docker-compose.yml'
const report = { startedAt: new Date().toISOString(), status: 'preflight', phases: [], probes: [] }
const reportUrl = new URL('./runtime-result.json', import.meta.url)
function save() { writeFileSync(reportUrl, JSON.stringify(report, null, 2) + '\n') }
function docker(args, input) { return execFileSync('docker', [...dockerArgs, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }) }
function inspect(id) { return JSON.parse(docker(['inspect', id]))[0] }
function envOf(c) { return Object.fromEntries(c.Config.Env.map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)])) }
function summary(c) { return { name: c.Name, id: c.Id, image: c.Image, state: c.State.Status, health: c.State.Health?.Status, startedAt: c.State.StartedAt, mounts: c.Mounts.map(m => ({ type: m.Type, name: m.Name, target: m.Destination, rw: m.RW })), ports: c.HostConfig.PortBindings, aliases: Object.fromEntries(Object.entries(c.NetworkSettings.Networks).map(([key, value]) => [key, value.Aliases])) } }
function query(sql) { return JSON.parse(docker(['exec', 'local-postgres-1', 'psql', '-U', 'merchant', '-d', 'merchant', '-X', '-Atqc', `BEGIN READ ONLY; ${sql}; COMMIT;`]).trim()) }
const eventId = 'evt_53285c3e-4c90-411f-be1a-f8d748b012f1'
const assetId = 'asset_e256fbc5-3b9b-4b8e-adef-b4addd92427e'
const workspaceId = 'ws_be87dca95d714bc1bbdb6c21'
function historicalEvidence() {
  return query(`SELECT json_build_object('event', (SELECT md5(row_to_json(e)::text) FROM outbox_events e WHERE workspace_id='${workspaceId}' AND id='${eventId}'), 'asset', (SELECT md5(row_to_json(a)::text) FROM business_entity_snapshots a WHERE workspace_id='${workspaceId}' AND entity_type='asset' AND entity_id='${assetId}'), 'attempt', (SELECT md5(row_to_json(a)::text) FROM asset_scan_attempts a WHERE workspace_id='${workspaceId}' AND outbox_event_id='${eventId}'), 'acceptedReceipts', (SELECT count(*) FROM asset_scan_receipts WHERE workspace_id='${workspaceId}' AND asset_id='${assetId}'))`)
}
const live = Object.fromEntries(prior.after.map(row => { const c = inspect(row.name); assert.equal(c.Id, row.id, 'Concurrent service replacement detected'); assert.equal(c.Image, row.image); assert.equal(c.Config.Labels['com.docker.compose.project'], 'local'); return [c.Config.Labels['com.docker.compose.service'], c] }))
const beforeEnv = Object.fromEntries(Object.entries(live).map(([service,c]) => [service, envOf(c)]))
report.before = Object.values(live).map(summary)
report.deadLetterBefore = historicalEvidence()
assert.ok(report.deadLetterBefore.event && report.deadLetterBefore.asset && report.deadLetterBefore.attempt)
report.claimableBefore = query("SELECT json_build_object('count',count(*)) FROM outbox_events WHERE workspace_id IN ('ws_demo','workspace_demo','demo-workspace','ws_be87dca95d714bc1bbdb6c21') AND event_type IN ('generation.requested','image.generation.requested','publish.requested','sync.requested','asset.uploaded','asset.generated_quarantined','asset.video_quarantined','asset.scan_redrive_requested','asset.customer_delivery_quarantined') AND published_at IS NULL AND unknown_at IS NULL AND (last_error IS NULL OR (last_error->'retryable'='true'::jsonb AND COALESCE(last_error->'unknown','false'::jsonb)='false'::jsonb)) AND COALESCE(last_error->>'terminal','false')<>'true' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())")
assert.equal(report.claimableBefore.count, 0, 'Unexpected executable backlog; stop before update')
const changedKeys = [...new Set([...Object.keys(beforeEnv.api), ...Object.keys(beforeEnv['api-replica'])])].filter(k => k !== 'OTEL_SERVICE_NAME' && beforeEnv.api[k] !== beforeEnv['api-replica'][k]).sort()
assert.equal(changedKeys.length, 16, 'Review changed configuration scope before update')
report.changedReplicaEnvironmentKeys = changedKeys
for (const key of ['DATABASE_URL','OPS_DATABASE_URL','REDIS_URL']) {
  if (beforeEnv.api[key] !== beforeEnv['api-replica'][key]) throw new Error(`Shared dependency differs: ${key}`)
}
if (beforeEnv.api.PERSISTENCE_MODE !== 'postgres' || beforeEnv['api-replica'].PERSISTENCE_MODE !== 'postgres') throw new Error('Postgres persistence is required')
const desiredEnv = { ...beforeEnv, 'api-replica': { ...beforeEnv.api, OTEL_SERVICE_NAME: beforeEnv['api-replica'].OTEL_SERVICE_NAME } }
async function modelProbe(port, env, platform = true) {
  const entries = Object.entries(JSON.parse(env.API_AUTH_TOKENS))
  const credential = entries.find(([,v]) => platform ? v.workbenches?.includes('platform') : v.workbenches?.includes('workspace') && !v.workbenches?.includes('platform'))
  assert.ok(credential)
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${credential[0]}`, 'x-ops-workbench': platform ? 'platform' : 'workspace', 'x-workspace-id': 'ws_demo', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'platform.model.status', arguments: {} } }) })
  const j = await response.json()
  const data = j.result?.structuredContent ?? (j.result?.content?.find(x => x.type === 'text')?.text ? JSON.parse(j.result.content.find(x => x.type === 'text').text) : undefined)
  return { port, httpStatus: response.status, platform, code: j.error?.data?.code, reasonCode: j.error?.data?.details?.reason_code, state: data?.state, capabilities: data?.capabilities, quotas: data?.quotas, costControlReady: data?.cost_control_ready, dataSha256: data ? createHash('sha256').update(JSON.stringify(data)).digest('hex') : undefined }
}
report.modelsBefore = [await modelProbe(8787, beforeEnv.api), await modelProbe(8788, beforeEnv['api-replica'])]
assert.equal(report.modelsBefore[0].state, 'ready')
assert.equal(report.modelsBefore[1].state, 'not_configured')
const images = Object.fromEntries(['api','worker'].map(role => [role, docker(['image','inspect','--format','{{.Id}}', `merchant-owner-${role}:20260915-replica-parity`]).trim()]))
for (const image of Object.values(images)) assert.match(image, /^sha256:[0-9a-f]{64}$/)
report.images = images
const gate = spawnSync('sh', ['infra/scripts/verify-container-source-freshness.sh', images.api, images.worker, images.api, images.worker], { env: { ...process.env, DOCKER_HOST: socket }, encoding: 'utf8' })
report.sourceFreshness = { exitCode: gate.status, output: gate.stdout }
assert.equal(gate.status, 0, 'Source freshness gate failed before update')
const compose = ['compose','-p','local','-f',base,'-f','-']
const overlay = JSON.stringify({ services: Object.fromEntries(Object.keys(live).map(service => [service, { image: service.startsWith('worker-') ? images.worker : images.api, environment: Object.fromEntries(Object.entries(desiredEnv[service]).map(([key, value]) => [key, value.replaceAll('$', '$$$$')])) }])) })
const resolved = JSON.parse(docker([...compose,'config','--format','json'], overlay))
for (const service of Object.keys(live)) {
  const resolvedEnv = resolved.services[service].environment
  const keys = [...new Set([...Object.keys(desiredEnv[service]), ...Object.keys(resolvedEnv)])].sort()
  const mismatches = keys.filter(key => String(resolvedEnv[key] ?? '') !== desiredEnv[service][key])
  if (mismatches.length) throw new Error(`Resolved config differs in keys: ${service}/${mismatches.join(',')}`)
}
save()
for (const services of [['api','api-replica'], Object.keys(live).filter(k => k.startsWith('worker-'))]) {
  for (const service of services) assert.equal(inspect(live[service].Name).Id, live[service].Id, 'Concurrent service update')
  const result = spawnSync('docker', [...dockerArgs,...compose,'up','-d','--no-deps','--no-build','--force-recreate',...services], { input: overlay, encoding: 'utf8', timeout: 120000 })
  report.phases.push({ services, exitCode: result.status, completedAt: new Date().toISOString() }); save()
  assert.equal(result.status, 0, 'Scoped update failed; no secrets emitted')
  console.log(JSON.stringify({ updated: services }))
  for (let attempt = 0; attempt < 60; attempt++) {
    if (services.every(service => inspect(`local-${service}-1`).State.Health?.Status === 'healthy')) break
    assert.notEqual(attempt, 59, 'Services did not become healthy')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}
report.after = Object.keys(live).map(service => {
  const c = inspect(`local-${service}-1`); const state = summary(c)
  const actualEnv = envOf(c)
  const envKeys = [...new Set([...Object.keys(desiredEnv[service]), ...Object.keys(actualEnv)])].sort()
  const envMismatches = envKeys.filter(key => actualEnv[key] !== desiredEnv[service][key])
  if (envMismatches.length) throw new Error(`Runtime config differs in keys: ${service}/${envMismatches.join(',')}`)
  assert.deepEqual(state.mounts, summary(live[service]).mounts)
  assert.deepEqual(state.ports, summary(live[service]).ports)
  assert.deepEqual(state.aliases, summary(live[service]).aliases)
  assert.equal(c.Image, service.startsWith('worker-') ? images.worker : images.api)
  return state
})
report.modelsAfter = [await modelProbe(8787, desiredEnv.api), await modelProbe(8788, desiredEnv['api-replica'])]
for (const probe of report.modelsAfter) { assert.equal(probe.state, 'ready'); assert.ok(Object.values(probe.capabilities).every(Boolean)) }
assert.equal(report.modelsAfter[0].dataSha256, report.modelsAfter[1].dataSha256)
for (const port of [8787,8788]) {
  const denied = await modelProbe(port, desiredEnv.api, false)
  assert.equal(denied.code, 'FORBIDDEN'); assert.equal(denied.reasonCode, 'AUTHZ_CAPABILITY_MISSING'); report.probes.push(denied)
  for (const path of ['/v1/products', '/v1/internal/assets/replica-parity-nonexistent/scan-result']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: path.endsWith('scan-result') ? 'POST' : 'GET', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, ...(path.endsWith('scan-result') ? { body: '{}' } : {}) })
    const body = await response.json(); assert.equal(response.status, path.endsWith('scan-result') ? 403 : 401)
    report.probes.push({ port,path,status:response.status,code:body.error?.code,requestId:body.request_id })
  }
  const response = await fetch(`http://127.0.0.1:${port}/releasez`); const j = await response.json(); assert.equal(j.data.ready, false)
  report.probes.push({ port,path:'/releasez',status:response.status,releaseReady:j.data.ready })
}
report.deadLetterAfter = historicalEvidence(); assert.deepEqual(report.deadLetterAfter, report.deadLetterBefore)
report.secretValuesWritten = false
report.status = 'passed-replica-configuration-parity'
report.completedAt = new Date().toISOString(); save()
console.log(JSON.stringify({ status: report.status, changedKeys: changedKeys.length, healthyServices: report.after.length, modelStatusEqual: true, historicalEvidenceUnchanged: true }))
