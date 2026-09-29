import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Json = Record<string, any>
type FetchLike = typeof fetch

export type ImageProviderE2eOptions = {
  baseUrl: string
  accessToken: string
  workspaceId: string
  productId: string
  direction?: string
  timeoutMs?: number
  pollMs?: number
  fetchImpl?: FetchLike
  evidenceReader?: (binding: { workspaceId: string; jobId: string; actionId: string; idempotencyKey: string }) => Promise<Json>
}

const TERMINAL = new Set(['succeeded', 'failed'])
const ALLOWED_METHODS = new Set(['catalog.image.generate', 'catalog.image.get'])

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`)
  return value.trim()
}

function unwrap(envelope: Json): Json {
  if (envelope?.error) throw new Error(`${envelope.error.code ?? 'MCP_ERROR'}: ${envelope.error.message ?? 'unknown error'}`)
  const value = envelope?.result ?? envelope?.data?.result ?? envelope?.data
  if (!value || typeof value !== 'object') throw new Error('invalid_mcp_response')
  return value
}

export function freshImageE2eIdempotencyKey(now = new Date(), entropy = randomBytes(12).toString('hex')): string {
  return `image-provider-e2e:${now.toISOString().replace(/[^0-9]/gu, '')}:${entropy}`
}

export async function runImageProviderE2e(options: ImageProviderE2eOptions): Promise<Json> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = required(options.baseUrl, 'base_url').replace(/\/$/u, '')
  const workspaceId = required(options.workspaceId, 'workspace_id')
  const productId = required(options.productId, 'product_id')
  const accessToken = required(options.accessToken, 'access_token')
  // This harness intentionally offers no idempotency override. Every invocation
  // represents one new, billable provider job and must never replay an older run.
  const idempotencyKey = freshImageE2eIdempotencyKey()
  const timeoutMs = options.timeoutMs ?? 8 * 60_000
  const pollMs = options.pollMs ?? 3_000
  const calls: Array<{ method: string; jobId?: string }> = []
  let rpcId = 0

  const call = async (method: string, params: Json): Promise<Json> => {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`unsafe_method_forbidden:${method}`)
    calls.push({ method, ...(typeof params.job_id === 'string' ? { jobId: params.job_id } : {}) })
    const response = await fetchImpl(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, workspace_id: workspaceId } }),
    })
    if (!response.ok) throw new Error(`mcp_http_${response.status}`)
    return unwrap(await response.json() as Json)
  }

  const generated = await call('catalog.image.generate', {
    product_id: productId,
    mode: 'create',
    count: '1',
    direction: options.direction ?? '安全验收：保持商品事实不变，生成一张简洁白底电商主图候选',
    idempotency_key: idempotencyKey,
  })
  const jobId = required(generated.job_id ?? generated.job?.id, 'job_id')
  if (calls.filter(item => item.method === 'catalog.image.generate').length !== 1) throw new Error('multiple_image_jobs_detected')
  const deadline = Date.now() + timeoutMs
  let job = generated
  while (!TERMINAL.has(String(job.state ?? job.job?.state))) {
    if (Date.now() >= deadline) throw new Error(`image_job_timeout:${jobId}`)
    await new Promise(resolveWait => setTimeout(resolveWait, pollMs))
    job = await call('catalog.image.get', { job_id: jobId })
    const returnedJobId = required(job.job_id ?? job.job?.id, 'polled_job_id')
    if (returnedJobId !== jobId) throw new Error(`poll_job_identity_mismatch:${returnedJobId}`)
  }
  if (calls.some(item => item.method === 'catalog.image.get' && item.jobId !== jobId)) throw new Error('cross_job_poll_detected')
  if (calls.some(item => !ALLOWED_METHODS.has(item.method))) throw new Error('unsafe_method_detected')

  const actionId = `image:${idempotencyKey}`
  const durableEvidence = options.evidenceReader
    ? await options.evidenceReader({ workspaceId, jobId, actionId, idempotencyKey })
    : { status: 'not_collected', reason: 'evidence_reader_not_configured' }
  return {
    schema_version: 1,
    evidence_kind: 'single-image-provider-e2e',
    safety: { generated_count: 1, selected: false, reviewed: false, approved: false, published: false },
    binding: { workspace_id: workspaceId, product_id: productId, job_id: jobId, action_id: actionId, idempotency_key: idempotencyKey },
    request: { method: 'catalog.image.generate', mode: 'create', count: 1 },
    job,
    durable_evidence: durableEvidence,
    calls,
  }
}

export async function postgresImageEvidence(databaseUrl: string, binding: { workspaceId: string; jobId: string; actionId: string; idempotencyKey: string }): Promise<Json> {
  const { Client } = await import('pg')
  const client = new Client({ connectionString: required(databaseUrl, 'database_url'), application_name: 'image-provider-e2e-readonly-evidence' })
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [binding.workspaceId])
    const [execution, usage, reservation, snapshot] = await Promise.all([
      client.query('SELECT state,attempt,provider_request_id,provider_operation_key,error_code,created_at,updated_at FROM image_generation_executions WHERE workspace_id=$1 AND job_id=$2', [binding.workspaceId, binding.jobId]),
      client.query('SELECT id,action_id,modality,model,provider_request_id,input_tokens,output_tokens,total_tokens,cost_cny,settlement_status,receipt_key,observed_at FROM model_usage_ledger WHERE workspace_id=$1 AND action_id=$2 ORDER BY observed_at,id', [binding.workspaceId, binding.actionId]),
      client.query('SELECT r.id,r.action_key,r.points,r.status,r.settled_points,r.created_at,r.finalized_at,o.kind,o.status AS operation_status,o.idempotency_key FROM creative_point_reservations r JOIN creative_point_operations o ON o.workspace_id=r.workspace_id AND o.id=r.operation_id WHERE r.workspace_id=$1 AND r.action_key=$2', [binding.workspaceId, binding.actionId]),
      client.query("SELECT payload FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='image_generation_job' AND entity_id=$2", [binding.workspaceId, binding.jobId]),
    ])
    const payload = snapshot.rows[0]?.payload ?? null
    const assetIds = Array.isArray(payload?.outputs)
      ? payload.outputs.map((output: Json) => output?.assetId).filter((value: unknown): value is string => typeof value === 'string' && Boolean(value))
      : []
    const assets = assetIds.length
      ? await client.query("SELECT entity_id,payload->>'scanStatus' AS scan_status,payload->>'scanVerdict' AS scan_verdict,payload->>'scanReceiptId' AS scan_receipt_id,payload->>'scanReceiptDigest' AS scan_receipt_digest,payload->>'rightsStatus' AS rights_status FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=ANY($2::text[]) ORDER BY entity_id", [binding.workspaceId, assetIds])
      : { rows: [] }
    await client.query('COMMIT')
    return {
      status: 'collected',
      execution: execution.rows[0] ?? null,
      usage: usage.rows,
      reservation: reservation.rows[0] ?? null,
      archive: payload ? { state: payload.archiveState ?? null, outputs: payload.outputs ?? [] } : null,
      scan: assets.rows,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  if (process.env.IMAGE_PROVIDER_E2E_RUN !== 'true') throw new Error('Set IMAGE_PROVIDER_E2E_RUN=true to acknowledge one real, billable image generation.')
  const databaseUrl = required(process.env.IMAGE_PROVIDER_E2E_DATABASE_URL, 'IMAGE_PROVIDER_E2E_DATABASE_URL')
  const report = await runImageProviderE2e({
    baseUrl: required(process.env.IMAGE_PROVIDER_E2E_BASE_URL, 'IMAGE_PROVIDER_E2E_BASE_URL'),
    accessToken: required(process.env.IMAGE_PROVIDER_E2E_ACCESS_TOKEN, 'IMAGE_PROVIDER_E2E_ACCESS_TOKEN'),
    workspaceId: required(process.env.IMAGE_PROVIDER_E2E_WORKSPACE_ID, 'IMAGE_PROVIDER_E2E_WORKSPACE_ID'),
    productId: required(process.env.IMAGE_PROVIDER_E2E_PRODUCT_ID, 'IMAGE_PROVIDER_E2E_PRODUCT_ID'),
    ...(process.env.IMAGE_PROVIDER_E2E_DIRECTION ? { direction: process.env.IMAGE_PROVIDER_E2E_DIRECTION } : {}),
    evidenceReader: binding => postgresImageEvidence(databaseUrl, binding),
  })
  const output = resolve(process.env.IMAGE_PROVIDER_E2E_OUTPUT ?? `image-provider-e2e-${Date.now()}.json`)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  const evidence = report.durable_evidence
  const passed = (report.job?.state ?? report.job?.job?.state) === 'succeeded'
    && evidence.execution?.provider_request_id
    && evidence.usage?.length === 1
    && evidence.usage[0]?.cost_cny != null
    && evidence.reservation?.status === 'settled'
    && evidence.archive?.state === 'archived'
    && evidence.scan?.length === 1
    && evidence.scan[0]?.scan_status === 'clean'
    && evidence.scan[0]?.scan_receipt_id
  console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', job_id: report.binding.job_id, evidence_path: output, approved: false, published: false }))
  if (!passed) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
