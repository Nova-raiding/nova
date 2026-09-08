import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { runOpsE2e, opsChildEnvironment, type OpsE2eContext } from '../../../scripts/run-ops-oidc-e2e.js'

// Artifact-only observer. The default real suite keeps its revoke-success
// expectation and its nonzero exit. Capture success is NOT feature success.
const prefix = 'JIT_CAPTURE_FACTS:'
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
    const facts = { events, invalid_ttl_locally_blocked: false };
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
        if (events.some(event => event.method === 'ops.authorization.grant.issue')) throw new Error('CAPTURE_INVALID_TTL_REACHED_API');
        facts.invalid_ttl_locally_blocked = true;
      },
      emit() { console.log('${prefix}' + JSON.stringify(facts)); }
    };
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const target = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
        const payload = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : null;
        if (target.origin === location.origin && target.pathname === '/api/mcp' && allowed.has(payload?.method)) {
          const envelope = await response.clone().json();
          const result = envelope.result ?? envelope.data?.result;
          const error = envelope.error ?? envelope.data?.error;
          events.push({
            at: new Date().toISOString(), method: payload.method, status: response.status,
            error_code: error?.code ?? null,
            reason_code: error?.details?.reason_code ?? null,
            obligations_missing: error?.details?.obligations_missing ?? null,
            decision_id: error?.details?.decision_id ?? null,
            request_id: envelope.request_id ?? null,
            resource_scope: payload.params?.resource_scope_json ? JSON.parse(payload.params.resource_scope_json) : null,
            expected_authorization_revision: payload.params?.expected_authorization_revision ?? null,
            authorization_revision: result?.authorizationRevision ?? result?.authorization_revision ?? null,
            grant_count: Array.isArray(result?.grants) ? result.grants.length : null
          });
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
    output: resolve(captureDir, 'jit-signed-login-issue-revoke-denied.webm'),
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
        { wait_for: `${form} :text-is("只读 JIT 最长 15 分钟")` }, { pause: 0.6 },
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
      { name: 'Real revoke click preserves known enforce denial', do: [
        { click: `${row} button:has-text("立即撤销")` }, { wait_for: '[role="dialog"]' },
        fill('[role="dialog"] textarea', `隔离录屏申请撤销 ${ticket}`),
        { screenshot: resolve(captureDir, '03-revoke-confirmation.png') }, { pause: 1 },
        { click: '[role="dialog"] button:has-text("确认撤销")' },
        waitRpc('ops.authorization.grant.revoke', 1, 403),
        { wait_for: '[role="dialog"] :text-is("操作未完成")' },
        { screenshot: resolve(captureDir, '04-revoke-denied-input-retained.png') },
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
  let facts: { events: Array<Record<string, unknown>>; invalid_ttl_locally_blocked: boolean } | undefined
  if (lastFacts) {
    try { facts = JSON.parse(lastFacts) } catch { /* failed safely below */ }
  }
  const progress = storyboard.scenes.map(scene => scene.name).filter(name => toolOutput.includes(name))
  await writeEvidence(resolve(captureDir, 'shot-scraper.redacted.json'), { tool: 'shot-scraper video', toolExit, progress, rawStoryboardSaved: false, rawToolOutputSaved: false, facts: facts ?? null })
  assert(toolExit === 0, 'CAPTURE_TOOL_FAILED')
  assert(facts?.invalid_ttl_locally_blocked, 'CAPTURE_TTL_PROBE_NOT_CONFIRMED')
  const revoked = facts.events.find(event => event.method === 'ops.authorization.grant.revoke')
  assert(revoked?.status === 403 && revoked.reason_code === 'AUTHZ_OBLIGATION_REQUIRED', 'CAPTURE_KNOWN_REVOKE_DENIAL_NOT_CONFIRMED')
  for (const name of ['jit-signed-login-issue-revoke-denied.mp4', '01-invalid-ttl-locally-blocked.png', '02-issued-and-explicitly-refreshed.png', '03-revoke-confirmation.png', '04-revoke-denied-input-retained.png']) assert((await stat(resolve(captureDir, name))).size > 0, 'CAPTURE_OUTPUT_MISSING')
  return { toolExit, facts }
}

async function readOwnPersistence(context: OpsE2eContext, captureDir: string, ticket: string, startedAt: string) {
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
      const grants = (await client.query(`SELECT g.id::text AS grant_id,g.workspace_id,g.ticket_ref,g.access_mode,g.capabilities,g.resource_scope,g.issued_at,g.expires_at,g.revoked_at,g.use_count,g.max_uses,g.revision,g.authorization_revision::text,r.revision::text AS subject_authorization_revision,
        (SELECT count(*)::integer FROM ops_access_grant_events e WHERE e.grant_id=g.id AND e.event_type='issued') AS issued_event_count,
        (SELECT count(*)::integer FROM ops_access_grant_events e WHERE e.grant_id=g.id AND e.event_type='revoked') AS revoked_event_count
        FROM ops_access_grants g JOIN authorization_revisions r ON r.subject_identity_id=g.subject_identity_id
        WHERE g.subject_identity_id=$1::uuid AND g.workspace_id=$2 AND g.issued_by=$3 AND g.ticket_ref=$4`, [fixture.subjectIdentityId, fixture.workspaceId, fixture.actorSubject, ticket])).rows
      const audit = (await client.query(`SELECT decision_id,request_id,method,capability,workbench,result,reason_code,resource_type,resource_id,evidence #> '{obligations,missing}' AS obligations_missing,created_at
        FROM platform_authorization_audit WHERE actor_id=$1 AND method IN ('ops.authorization.grant.issue','ops.authorization.grant.revoke') AND created_at >= $2::timestamptz ORDER BY created_at,id`, [fixture.actorSubject, startedAt])).rows
      await client.query('COMMIT')
      const redactedGrants = grants.map(({ grant_id, ...grant }) => ({ ...grant, grant_ref: hash(grant_id) }))
      const evidence = { fixture_ref: hash(fixture.runId), read_boundary: boundary, captured_ticket: ticket, subject_ref: hash(fixture.subjectIdentityId), actor_ref: hash(fixture.actorSubject), grants: redactedGrants, audit, audit_correlation: 'own actor plus capture time window; decision_id also available in browser facts', rawConnectionStringsSaved: false }
      await writeEvidence(resolve(captureDir, 'postgres-readonly.redacted.json'), evidence)
      assert(grants.length === 1, 'CAPTURE_PERSISTED_GRANT_NOT_UNIQUE')
      const grant = grants[0]
      assert(grant.issued_event_count === 1 && grant.revoked_event_count === 0 && grant.revoked_at === null && grant.revision === 1 && grant.use_count === 0, 'CAPTURE_PERSISTED_GRANT_STATE_UNEXPECTED')
      assert(JSON.stringify(grant.resource_scope) === JSON.stringify({ workspace_ids: [fixture.workspaceId] }), 'CAPTURE_PERSISTED_SCOPE_UNEXPECTED')
      assert(audit.some(row => row.method === 'ops.authorization.grant.revoke' && row.result === 'deny' && row.reason_code === 'AUTHZ_OBLIGATION_REQUIRED' && Array.isArray(row.obligations_missing) && row.obligations_missing.includes('approval')), 'CAPTURE_DURABLE_DENY_AUDIT_MISSING')
      return { persistedGrantCount: grants.length, revokeExecuted: false }
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
  } finally { await pool.end() }
}

let evidenceDirectory: string | undefined
let captureStatus = 'not_started'
runOpsE2e([], process.env, async context => {
  const captureDir = resolve(context.evidenceDir, 'live-desktop-capture')
  evidenceDirectory = captureDir
  await mkdir(captureDir, { mode: 0o700 })
  const ticket = `JIT-CAPTURE-${randomUUID()}`
  const startedAt = new Date().toISOString()
  try {
    captureStatus = 'running'
    const capture = await recordDesktop(context, captureDir, ticket)
    const persistence = await readOwnPersistence(context, captureDir, ticket, startedAt)
    captureStatus = 'evidence_captured_known_revoke_failure'
    await writeEvidence(resolve(captureDir, 'capture-summary.json'), { status: captureStatus, featureVerdict: 'FAIL', viewport: { width: 1440, height: 900 }, captureToolExit: capture.toolExit, invalidTtlProbe: 'local_rejection_no_issue_rpc', issue: '200_and_persisted', revoke: '403_AUTHZ_OBLIGATION_REQUIRED_not_executed', ...persistence, modelsCalled: false, sharedServicesUsed: false, startedAt, finishedAt: new Date().toISOString() })
  } catch (error) {
    captureStatus = 'capture_blocked'
    const code = error instanceof Error && /^CAPTURE_[A-Z_]+$/u.test(error.message) ? error.message : 'CAPTURE_FAILED'
    await writeEvidence(resolve(captureDir, 'capture-blocked.json'), { status: captureStatus, featureVerdict: 'FAIL', code, startedAt, finishedAt: new Date().toISOString() })
    throw new Error(code)
  }
}).then(suiteExit => {
  console.log(JSON.stringify({ evidenceDirectory, captureStatus, suiteExit, featureVerdict: 'FAIL', note: 'Capture success is not JIT lifecycle acceptance; original revoke-success assertions remain unchanged.' }))
  process.exitCode = suiteExit
}, error => {
  const code = error instanceof Error && /^(?:CAPTURE|ISOLATED_FIXTURE|OPS_E2E)_[A-Z_]+$/u.test(error.message) ? error.message : 'CAPTURE_RUN_FAILED'
  console.error(JSON.stringify({ evidenceDirectory, captureStatus, code, featureVerdict: 'FAIL' }))
  process.exitCode = 1
})
