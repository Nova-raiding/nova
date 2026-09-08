import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { runOpsE2e, opsChildEnvironment, type OpsE2eContext } from '../../../scripts/run-ops-oidc-e2e.js'

// Artifact-only observer for the explicitly approved revoke-policy change.
// Preserve the old failed capture; run only after owner confirms policy green.
// The default real suite retains both desktop cases and all original assertions.
const prefix = 'JIT_REVOKE_CAPTURE_FACTS:'
type CaptureFacts = { events: Array<Record<string, unknown>>; started: Array<{ at: string; method: string }>; invalid_ttl_locally_blocked: boolean; empty_revoke_reason_locally_blocked: boolean }
let observedCaptureFacts: CaptureFacts | undefined
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`
const writeEvidence = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code) }

function responseObserver() {
  // No direct POSTs, storage manipulation, response mutation or DOM changes.
  // The only installed runtime instrumentation observes real fetch exchanges.
  return `(() => {
    const originalFetch = window.fetch;
    const allowed = new Set(['ops.authorization.grants.list','ops.authorization.grant.issue','ops.authorization.grant.revoke']);
    const events = [];
    let issuedGrantId;
    const facts = { events, started: [], invalid_ttl_locally_blocked: false, empty_revoke_reason_locally_blocked: false };
    const emitFacts = () => console.log('${prefix}' + JSON.stringify(facts));
    window.__jitCapture = {
      facts,
      async waitFor(method, count, status) {
        const until = Date.now() + 30000;
        while (Date.now() < until) {
          const matches = events.filter(event => event.method === method);
          if (matches.length >= count) {
            if (matches[count - 1].status !== status) throw new Error('CAPTURE_UNEXPECTED_RPC_STATUS');
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('CAPTURE_RPC_OBSERVATION_TIMEOUT');
      },
      confirmInvalidTtl() {
        if (facts.started.some(event => event.method === 'ops.authorization.grant.issue')) throw new Error('CAPTURE_INVALID_TTL_REACHED_API');
        facts.invalid_ttl_locally_blocked = true;
        emitFacts();
      },
      confirmEmptyRevokeReason() {
        if (facts.started.some(event => event.method === 'ops.authorization.grant.revoke')) throw new Error('CAPTURE_EMPTY_REASON_REACHED_API');
        facts.empty_revoke_reason_locally_blocked = true;
        emitFacts();
      },
      emit() { emitFacts(); }
    };
    window.fetch = async function(...args) {
      let observedPayload;
      try {
        const target = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
        const payload = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : null;
        if (target.origin === location.origin && target.pathname === '/api/mcp' && allowed.has(payload?.method)) {
          observedPayload = payload;
          facts.started.push({ at: new Date().toISOString(), method: payload.method });
          emitFacts();
        }
      } catch { /* observation cannot change the application request */ }
      const response = await originalFetch.apply(this, args);
      try {
        if (observedPayload) {
          const payload = observedPayload;
          const envelope = await response.clone().json();
          const result = envelope.result ?? envelope.data?.result;
          const error = envelope.error ?? envelope.data?.error;
          if (payload.method === 'ops.authorization.grant.issue' && response.ok && typeof result?.id === 'string') issuedGrantId = result.id;
          events.push({
            at: new Date().toISOString(), method: payload.method, status: response.status,
            error_code: error?.code ?? null,
            reason_code: error?.details?.reason_code ?? null,
            obligations_missing: error?.details?.obligations_missing ?? null,
            decision_id: error?.details?.decision_id ?? null,
            request_id: envelope.request_id ?? null,
            resource_scope: payload.params?.resource_scope_json ? JSON.parse(payload.params.resource_scope_json) : null,
            expected_authorization_revision: payload.params?.expected_authorization_revision ?? null,
            grant_revision: result?.revision ?? null,
            revoked: Boolean(result?.revokedAt),
            captured_grant_present: Array.isArray(result?.grants) && issuedGrantId ? result.grants.some(grant => grant.id === issuedGrantId) : null,
            authorization_revision: result?.authorizationRevision ?? result?.authorization_revision ?? null,
            grant_count: Array.isArray(result?.grants) ? result.grants.length : null
          });
          emitFacts();
        }
      } catch { /* observation cannot change the application response */ }
      return response;
    };
  })()`
}

async function recordDesktop(context: OpsE2eContext, captureDir: string, ticket: string) {
  const { baseUrl, fixture } = context
  const form = 'form[aria-label="签发 JIT 授权"]'
  const field = (name: string) => `${form} input#${name}`
  const row = `tr:has(td:text-is("${ticket}"))`
  const approvedAt = new Date().toISOString()
  const invalidExpiry = new Date(Date.now() + 30 * 60_000).toISOString()
  const validExpiry = new Date(Date.now() + 10 * 60_000).toISOString()
  const fill = (into: string, text: string) => ({ fill: { into, text } })
  const waitRpc = (method: string, count: number, status: number) => ({ js: `window.__jitCapture.waitFor(${JSON.stringify(method)}, ${count}, ${status})` })
  const storyboard = {
    output: resolve(captureDir, 'jit-signed-login-issue-revoke.webm'),
    url: new URL('/ops/users?workbench=platform', baseUrl).toString(),
    viewport: { width: 1440, height: 900 }, cursor: true,
    scenes: [
      { name: 'Real signed OIDC login', do: [
        { wait_for: '#username' }, fill('#username', context.username),
        // The storyboard containing this generated password is sent through
        // stdin only. The actual input is type=password; never unmask it.
        fill('#password', context.password), { pause: 0.6 },
        { click: 'button[type="submit"]' }, { wait_for: 'h1:text-is("用户与租户"), h2:text-is("用户与租户"), h3:text-is("用户与租户"), h4:text-is("用户与租户")' },
      ] },
      { name: 'Open JIT and read durable current revision', do: [
        { click: '[role="tab"]:has-text("权限与角色")' },
        { click: '[role="tab"]:has-text("JIT 授权")' },
        { wait_for: form }, { js: responseObserver() },
        fill('input[aria-label="JIT 目标身份 ID"]', fixture.subjectIdentityId),
        fill('input[aria-label="JIT 目标工作区 ID"]', fixture.workspaceId),
        { click: 'button:has-text("读取有效 JIT")' }, waitRpc('ops.authorization.grants.list', 1, 200),
      ] },
      { name: 'Negative TTL probe through actual form', do: [
        fill(field('capabilities'), 'customer.content.read'), fill(field('ticket_ref'), ticket),
        fill(field('max_uses'), '2'), fill(field('approved_by'), fixture.approverId),
        fill(field('approved_at'), approvedAt), fill(field('expires_at'), invalidExpiry),
        fill(field('reason'), `隔离桌面录屏验收 ${ticket}`),
        { click: `${form} button[type="submit"]` },
        { wait_for: `${form} :text-is("只读 JIT 最长 15 分钟")` },
        { scroll: { to: field('expires_at'), duration: 0.5 } }, { pause: 0.6 },
        { js: 'window.__jitCapture.confirmInvalidTtl()' },
        { screenshot: resolve(captureDir, '01-invalid-ttl-locally-blocked.png') }, { pause: 1 },
      ] },
      { name: 'Submit exact workspace JIT and refresh persisted grant', do: [
        fill(field('expires_at'), validExpiry), { click: `${form} button[type="submit"]` },
        waitRpc('ops.authorization.grant.issue', 1, 200), waitRpc('ops.authorization.grants.list', 2, 200),
        { wait_for: row }, { click: 'button:has-text("读取有效 JIT")' },
        waitRpc('ops.authorization.grants.list', 3, 200), { wait_for: row },
        { scroll: { to: row, duration: 0.5 } },
        { screenshot: resolve(captureDir, '02-issued-and-explicitly-refreshed.png') }, { pause: 1.5 },
      ] },
      { name: 'Empty revoke reason remains disabled without an RPC', do: [
        { click: `${row} button:has-text("立即撤销")` }, { wait_for: '[role="dialog"]' },
        { wait_for: '[role="dialog"] button:disabled:has-text("确认撤销")' }, { pause: 0.6 },
        { js: 'window.__jitCapture.confirmEmptyRevokeReason()' },
        { screenshot: resolve(captureDir, '03-revoke-empty-reason-disabled.png') }, { pause: 1 },
      ] },
      { name: 'Real revoke succeeds and disappears from the active list', do: [
        fill('[role="dialog"] textarea', `隔离录屏申请撤销 ${ticket}`),
        { wait_for: '[role="dialog"] button:enabled:has-text("确认撤销")' }, { pause: 0.6 },
        { screenshot: resolve(captureDir, '04-revoke-confirmation.png') }, { pause: 1 },
        { click: '[role="dialog"] button:has-text("确认撤销")' },
        waitRpc('ops.authorization.grant.revoke', 1, 200),
        waitRpc('ops.authorization.grants.list', 4, 200),
        { wait_for: 'text=最近一次 JIT 已撤销' },
        { wait_for: `body:not(:has(${row}))` },
        { scroll: { to: 'text=最近一次 JIT 已撤销', duration: 0.5 } }, { pause: 0.6 },
        { screenshot: resolve(captureDir, '05-revoked-and-removed.png') },
        { js: 'window.__jitCapture.emit()' }, { pause: 2 },
      ] },
    ],
  }
  let toolOutput = ''
  const command = ['tool', 'run', '--from', 'shot-scraper', 'shot-scraper', 'video', '/dev/stdin', '-b', 'chrome', '--mp4', '--timeout', '60000', '--log-console']
  const toolExit = await new Promise<number>((done, reject) => {
    const child = spawn('uv', command, { env: opsChildEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { toolOutput += chunk.toString() })
    child.stderr.on('data', chunk => { toolOutput += chunk.toString() })
    child.once('error', () => reject(new Error('CAPTURE_TOOL_SPAWN_FAILED')))
    child.once('exit', code => done(code ?? 1))
    child.stdin.on('error', () => { /* exit result records a refused input pipe */ })
    child.stdin.end(JSON.stringify(storyboard))
  })
  // Never write raw tool output: a fill failure can quote storyboard input.
  const factLines = toolOutput.split('\n').filter(line => line.includes(prefix))
  const lastFacts = factLines.at(-1)?.split(prefix).slice(1).join(prefix)
  let facts: CaptureFacts | undefined
  if (lastFacts) {
    try { facts = JSON.parse(lastFacts) } catch { /* failed safely below */ }
  }
  observedCaptureFacts = facts
  const progress = storyboard.scenes.map(scene => scene.name).filter(name => toolOutput.includes(name))
  await writeEvidence(resolve(captureDir, 'shot-scraper.redacted.json'), { tool: 'shot-scraper video', toolExit, progress, rawStoryboardSaved: false, rawToolOutputSaved: false, facts: facts ?? null })
  assert(toolExit === 0, 'CAPTURE_TOOL_FAILED')
  assert(facts?.invalid_ttl_locally_blocked, 'CAPTURE_TTL_PROBE_NOT_CONFIRMED')
  assert(facts.empty_revoke_reason_locally_blocked, 'CAPTURE_EMPTY_REASON_PROBE_NOT_CONFIRMED')
  assert(facts.started.filter(event => event.method === 'ops.authorization.grant.issue').length === 1 && facts.started.filter(event => event.method === 'ops.authorization.grant.revoke').length === 1, 'CAPTURE_DUPLICATE_MUTATION_STARTED')
  const revoked = facts.events.find(event => event.method === 'ops.authorization.grant.revoke')
  const finalList = facts.events.filter(event => event.method === 'ops.authorization.grants.list').at(-1)
  assert(revoked?.status === 200 && revoked.revoked === true && revoked.grant_revision === 2, 'CAPTURE_REVOKE_SUCCESS_NOT_CONFIRMED')
  assert(finalList?.captured_grant_present === false, 'CAPTURE_REVOKED_GRANT_STILL_ACTIVE')
  for (const name of ['jit-signed-login-issue-revoke.mp4', '01-invalid-ttl-locally-blocked.png', '02-issued-and-explicitly-refreshed.png', '03-revoke-empty-reason-disabled.png', '04-revoke-confirmation.png', '05-revoked-and-removed.png']) assert((await stat(resolve(captureDir, name))).size > 0, 'CAPTURE_OUTPUT_MISSING')
  return { toolExit, facts }
}

async function readOwnPersistence(context: OpsE2eContext, captureDir: string, ticket: string, startedAt: string, facts: CaptureFacts | undefined, validateSuccess = true) {
  const { fixture } = context
  const url = new URL(fixture.opsDatabaseUrl)
  const postgres = fixture.containerEvidence.find(container => container.kind === 'postgres')
  assert(url.hostname === '127.0.0.1' && Number(url.port) === postgres?.hostPort && postgres.runId === fixture.runId && url.username === 'merchant_ops', 'CAPTURE_DATABASE_NOT_OWN_FIXTURE')
  const pool = new Pool({ connectionString: fixture.opsDatabaseUrl, max: 1, connectionTimeoutMillis: 2_000 })
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SELECT set_config('app.platform_scope','platform_ops',true)")
      const boundary = (await client.query("SELECT current_user AS role, current_setting('transaction_read_only') AS read_only, current_setting('app.platform_scope',true) AS platform_scope")).rows[0]
      assert(boundary?.role === 'merchant_ops' && boundary.read_only === 'on' && boundary.platform_scope === 'platform_ops', 'CAPTURE_READ_ONLY_BOUNDARY_FAILED')
      const grants = (await client.query(`SELECT g.id::text AS grant_id,g.workspace_id,g.ticket_ref,g.access_mode,g.capabilities,g.resource_scope,g.issued_at,g.expires_at,g.revoked_at,g.revoked_by=$3 AS revoked_by_authenticated_actor,length(g.revocation_reason)>=3 AS revocation_reason_present,g.use_count,g.max_uses,g.revision,g.authorization_revision::text,r.revision::text AS subject_authorization_revision,
        (SELECT count(*)::integer FROM ops_access_grant_events e WHERE e.grant_id=g.id AND e.event_type='issued') AS issued_event_count,
        (SELECT count(*)::integer FROM ops_access_grant_events e WHERE e.grant_id=g.id AND e.event_type='revoked') AS revoked_event_count
        FROM ops_access_grants g JOIN authorization_revisions r ON r.subject_identity_id=g.subject_identity_id
        WHERE g.subject_identity_id=$1::uuid AND g.workspace_id=$2 AND g.issued_by=$3 AND g.ticket_ref=$4`, [fixture.subjectIdentityId, fixture.workspaceId, fixture.actorSubject, ticket])).rows
      const events = (await client.query(`SELECT e.event_type,e.grant_revision,e.authorization_revision::text,e.created_at FROM ops_access_grant_events e JOIN ops_access_grants g ON g.id=e.grant_id WHERE g.subject_identity_id=$1::uuid AND g.workspace_id=$2 AND g.issued_by=$3 AND g.ticket_ref=$4 ORDER BY e.created_at,e.id`, [fixture.subjectIdentityId, fixture.workspaceId, fixture.actorSubject, ticket])).rows
      const audit = (await client.query(`SELECT decision_id,request_id,method,capability,workbench,result,reason_code,resource_type,resource_id,evidence #> '{obligations,required}' AS obligations_required,evidence #> '{obligations,missing}' AS obligations_missing,created_at
        FROM platform_authorization_audit WHERE actor_id=$1 AND method IN ('ops.authorization.grant.issue','ops.authorization.grant.revoke') AND created_at >= $2::timestamptz ORDER BY created_at,id`, [fixture.actorSubject, startedAt])).rows
      await client.query('COMMIT')
      const redactedGrants = grants.map(({ grant_id, ...grant }) => ({ ...grant, grant_ref: hash(grant_id) }))
      const evidence = { fixture_ref: hash(fixture.runId), read_boundary: boundary, captured_ticket: ticket, subject_ref: hash(fixture.subjectIdentityId), actor_ref: hash(fixture.actorSubject), grants: redactedGrants, events, audit, audit_correlation: 'own actor plus capture window; each issue/revoke browser request_id must exactly match a persisted audit request_id', rawConnectionStringsSaved: false }
      await writeEvidence(resolve(captureDir, validateSuccess ? 'postgres-readonly.redacted.json' : 'postgres-readonly-diagnostic.redacted.json'), { ...evidence, diagnosticOnly: !validateSuccess })
      if (!validateSuccess) return { persistedGrantCount: grants.length, diagnosticOnly: true }
      assert(facts, 'CAPTURE_BROWSER_FACTS_MISSING')
      assert(grants.length === 1, 'CAPTURE_PERSISTED_GRANT_NOT_UNIQUE')
      const grant = grants[0]
      assert(grant.issued_event_count === 1 && grant.revoked_event_count === 1 && grant.revoked_at !== null && grant.revision === 2 && grant.use_count === 0 && grant.revoked_by_authenticated_actor && grant.revocation_reason_present, 'CAPTURE_PERSISTED_GRANT_STATE_UNEXPECTED')
      assert(JSON.stringify(grant.resource_scope) === JSON.stringify({ workspace_ids: [fixture.workspaceId] }), 'CAPTURE_PERSISTED_SCOPE_UNEXPECTED')
      const initialRevision = Number(facts.events.find(event => event.method === 'ops.authorization.grants.list')?.authorization_revision)
      assert(Number.isSafeInteger(initialRevision) && Number(grant.subject_authorization_revision) === initialRevision + 2 && Number(grant.authorization_revision) === initialRevision + 2, 'CAPTURE_SUBJECT_REVISION_DID_NOT_ADVANCE_TWICE')
      assert(events.length === 2 && events[0]?.event_type === 'issued' && events[0].grant_revision === 1 && Number(events[0].authorization_revision) === initialRevision + 1 && events[1]?.event_type === 'revoked' && events[1].grant_revision === 2 && Number(events[1].authorization_revision) === initialRevision + 2, 'CAPTURE_GRANT_EVENT_SEQUENCE_INVALID')
      for (const method of ['ops.authorization.grant.issue', 'ops.authorization.grant.revoke']) {
        const browserEvent = facts.events.find(event => event.method === method)
        const persisted = audit.find(row => row.method === method && row.request_id === browserEvent?.request_id)
        assert(typeof browserEvent?.request_id === 'string' && persisted?.result === 'allow' && persisted.reason_code === 'AUTHZ_ALLOWED' && persisted.workbench === 'platform' && persisted.capability === 'authorization.grant.manage' && Array.isArray(persisted.obligations_missing) && persisted.obligations_missing.length === 0, 'CAPTURE_MATCHING_ALLOW_AUDIT_MISSING')
        assert(Array.isArray(persisted.obligations_required) && persisted.obligations_required.includes('reason') && persisted.obligations_required.includes('revision') && persisted.obligations_required.includes('approval') === (method === 'ops.authorization.grant.issue'), 'CAPTURE_AUDIT_POLICY_OBLIGATIONS_UNEXPECTED')
      }
      return { persistedGrantCount: grants.length, revokeExecuted: true, subjectRevisionBefore: initialRevision, subjectRevisionAfter: Number(grant.subject_authorization_revision) }
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
  } finally { await pool.end() }
}

async function preserveFailedVideo(captureDir: string) {
  const webm = resolve(captureDir, 'jit-signed-login-issue-revoke.webm')
  const mp4 = resolve(captureDir, 'jit-signed-login-issue-revoke.mp4')
  const frame = resolve(captureDir, 'failure-final-frame.png')
  const exists = (path: string) => stat(path).then(value => value.size > 0, () => false)
  const run = (args: string[]) => new Promise<number>(done => {
    // Decode only the already-recorded own artifact. No new browser requests.
    const child = spawn('ffmpeg', args, { env: opsChildEnvironment(process.env), stdio: ['ignore', 'ignore', 'ignore'] })
    child.once('error', () => done(1))
    child.once('exit', code => done(code ?? 1))
  })
  let conversionExit: number | null = null
  let frameExit: number | null = null
  if (await exists(webm)) {
    if (!await exists(mp4)) conversionExit = await run(['-nostdin', '-v', 'error', '-n', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4])
    if (await exists(mp4)) frameExit = await run(['-nostdin', '-v', 'error', '-n', '-sseof', '-0.1', '-i', mp4, '-frames:v', '1', frame])
  }
  await writeEvidence(resolve(captureDir, 'failed-video-retention.json'), { webmRetained: await exists(webm), mp4Retained: await exists(mp4), failureFrameRetained: await exists(frame), conversionExit, frameExit, source: 'existing shot-scraper recording, no new browser interaction', verdict: 'FAIL' })
}

let evidenceDirectory: string | undefined
let captureStatus = 'not_started'
runOpsE2e([], process.env, async context => {
  const captureDir = resolve(context.evidenceDir, 'live-desktop-revoke-capture')
  evidenceDirectory = captureDir
  await mkdir(captureDir, { mode: 0o700 })
  const ticket = `JIT-REVOKE-CAPTURE-${randomUUID()}`
  const startedAt = new Date().toISOString()
  try {
    captureStatus = 'running'
    const capture = await recordDesktop(context, captureDir, ticket)
    const persistence = await readOwnPersistence(context, captureDir, ticket, startedAt, capture.facts)
    captureStatus = 'isolated_revoke_lifecycle_captured'
    await writeEvidence(resolve(captureDir, 'capture-summary.json'), { status: captureStatus, captureVerdict: 'PASS', scope: 'isolated signed OIDC desktop JIT issue/revoke only; not ChatGPT host or full release', viewport: { width: 1440, height: 900 }, captureToolExit: capture.toolExit, invalidTtlProbe: 'local_rejection_no_issue_rpc', emptyRevokeReasonProbe: 'disabled_no_revoke_rpc', issue: '200_and_persisted', revoke: '200_persisted_and_removed', ...persistence, modelsCalled: false, sharedServicesUsed: false, startedAt, finishedAt: new Date().toISOString() })
  } catch (error) {
    captureStatus = 'capture_failed'
    const code = error instanceof Error && /^CAPTURE_[A-Z_]+$/u.test(error.message) ? error.message : 'CAPTURE_FAILED'
    await preserveFailedVideo(captureDir)
    try { await readOwnPersistence(context, captureDir, ticket, startedAt, observedCaptureFacts, false) }
    catch { await writeEvidence(resolve(captureDir, 'postgres-diagnostic-blocked.json'), { diagnosticOnly: true, code: 'CAPTURE_READONLY_DIAGNOSTIC_FAILED', rawConnectionStringsSaved: false }) }
    await writeEvidence(resolve(captureDir, 'capture-blocked.json'), { status: captureStatus, featureVerdict: 'FAIL', code, startedAt, finishedAt: new Date().toISOString() })
    throw new Error(code)
  }
}).then(suiteExit => {
  console.log(JSON.stringify({ evidenceDirectory, captureStatus, suiteExit, scopedVerdict: suiteExit === 0 && captureStatus === 'isolated_revoke_lifecycle_captured' ? 'PASS' : 'FAIL', scope: 'isolated signed OIDC desktop JIT lifecycle; not ChatGPT host or full release', originalSuiteAssertionsUnchanged: true }))
  process.exitCode = suiteExit
}, error => {
  const code = error instanceof Error && /^(?:CAPTURE|ISOLATED_FIXTURE|OPS_E2E)_[A-Z_]+$/u.test(error.message) ? error.message : 'CAPTURE_RUN_FAILED'
  console.error(JSON.stringify({ evidenceDirectory, captureStatus, code, featureVerdict: 'FAIL' }))
  process.exitCode = 1
})
