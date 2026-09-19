import { afterEach, describe, expect, it } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, service } from './server.js'

/**
 * Delivery drift: the platform accepted the confirmed content while the local
 * task moved to a different version. The job is parked in `reconciling` and the
 * task stays in `publishing`.
 *
 * These tests pin the two operational surfaces that used to ignore that state —
 * the operational alert stream and the automation to-do queue — as well as the
 * only exit an operator has from it.
 */
const fixtureBases = new Set<string>()
const fixtureFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (![...fixtureBases].some(base => url.startsWith(base))) return fixtureFetch(input, init)
  const headers = new Headers(init?.headers)
  headers.set('x-test-commercial-fixture', 'server-e2e')
  return fixtureFetch(input, { ...init, headers })
}

type Envelope = { data: any; error: { code?: string; message?: string } | null }
async function start() {
  await new Promise<void>((resolve, reject) => { const onError = (error: Error) => reject(error); server.once('error', onError); server.listen(0, () => { server.removeListener('error', onError); resolve() }) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}`
  fixtureBases.add(base)
  return base
}
async function call(base: string, workspaceId: string, method: string, params: Record<string, unknown>, role?: string) {
  await grantCreativePointsForTests(workspaceId)
  grantContinuousFeatureEntitlementForTests(workspaceId)
  return await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }) }).then(response => response.json() as Promise<Envelope>)
}

/** Drives one publish into the drift escalation and returns its entities. */
function driftedPublish(workspaceId: string) {
  const product = service.importProduct({ workspaceId, platform: 'taobao', title: '漂移对账外套', stock: 50, price: 199 })
  service.confirmProductFacts(workspaceId, product.id)
  const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao' })
  service.answerTask(workspaceId, task.id, { confirm_facts: true })
  service.selectDirection(task.id, 'A')
  const version = service.createDraft(task.id)
  service.approveContent(task.id, version.id)
  const preview = service.preparePublish(task.id)
  const job = service.confirmPublish({ workspaceId, taskId: task.id, contentVersionId: version.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: `${workspaceId}-drift` })
  // A concurrent writer moves the task pointer to a newer, unapproved version.
  const moved = { ...structuredClone(version), id: `${version.id}_drifted`, state: 'review_required' as const, revision: 1 }
  service.contentVersions.set(moved.id, moved)
  task.contentVersionId = moved.id
  service.recordPublishObservation({ workspaceId, publishJobId: job.id, status: { found: true, state: 'published', remoteId: 'TB-DRIFT-ALERT-1', requestId: `request-${workspaceId}`, simulated: false } })
  return { product, task, version, moved, job }
}

describe('publish delivery drift operational surfaces', () => {
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('alerts, queues and settles a drifted publish that is already live', async () => {
    const base = await start(); const workspaceId = `ws_drift_alert_${Date.now()}`
    const drift = driftedPublish(workspaceId)
    expect(drift.job).toMatchObject({ state: 'reconciling', remoteState: 'published' })

    // REPRO (problem 3): a jarringly live-vs-drifted publish produced neither an
    // operational alert nor an automation to-do item, so the workspace quota it
    // holds (and the merchant task it stranded in `publishing`) stayed invisible.
    const alerts = await call(base, workspaceId, 'ops.alerts.list', { status: 'open', entity_id: drift.job.id })
    expect(alerts.error).toBeNull()
    expect(alerts.data.result).toEqual([expect.objectContaining({
      code: 'PUBLISH_DELIVERY_RECONCILIATION_REQUIRED',
      severity: 'high',
      entityType: 'publish_job',
      entityId: drift.job.id,
      evidence: expect.objectContaining({ state: 'reconciling', remoteState: 'published', deliveryReconciliation: expect.objectContaining({ code: 'PUBLISH_DELIVERY_TASK_DRIFT', jobContentVersionId: drift.version.id, taskContentVersionId: drift.moved.id }) }),
    })])

    const scan = await call(base, workspaceId, 'automation.scan', {})
    expect(scan.error).toBeNull()
    expect(scan.data.result.risks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'publish_attention', publish_job_id: drift.job.id })]))
    expect(scan.data.result.recommendations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'publish_attention', priority: 'high', method: 'publish.get', parameters: { job_id: drift.job.id } })]))

    // READ EXIT (problem 4): the reconciliation record used to be write-only.
    const before = await call(base, workspaceId, 'publish.get', { publish_job_id: drift.job.id })
    expect(before.error).toBeNull()
    expect(before.data.result.workflow.reconciliation).toMatchObject({ code: 'PUBLISH_DELIVERY_TASK_DRIFT', remoteState: 'published', taskState: 'publishing', settled: false, close_method: 'ops.marketing.publish.acknowledge' })

    const acknowledged = await call(base, workspaceId, 'ops.marketing.publish.acknowledge', { publish_job_id: drift.job.id, reason: '已与平台核对：内容确已上线，任务内容漂移，关闭对账并交回商家' })
    expect(acknowledged.error).toBeNull()
    expect(acknowledged.data.result).toMatchObject({ state: 'manual_attention', remoteState: 'published', operatorAcknowledgement: { actorId: expect.any(String), reason: expect.stringContaining('关闭对账'), acknowledgedAt: expect.any(String) } })
    // The merchant gets the task back and the observed remote object is pinned.
    expect(drift.task.state).toBe('review_required')
    expect(drift.product.remoteId).toBe('TB-DRIFT-ALERT-1')

    const after = await call(base, workspaceId, 'publish.get', { publish_job_id: drift.job.id })
    // `taskState` stays the escalated snapshot; `task_state` is where the task is now.
    expect(after.data.result.workflow.reconciliation).toMatchObject({ settled: true, taskState: 'publishing', task_state: 'review_required', acknowledged_by: expect.any(String), acknowledgement_reason: expect.stringContaining('关闭对账') })

    // A settled reconciliation stops occupying the open alert list and the to-do
    // queue, and its alert carries the operator's decision rather than a stale
    // "needs reconciliation" instruction.
    const settledAlerts = await call(base, workspaceId, 'ops.alerts.list', { status: 'open', entity_id: drift.job.id })
    expect(settledAlerts.data.result).toEqual([])
    const closedAlerts = await call(base, workspaceId, 'ops.alerts.list', { status: 'acknowledged', entity_id: drift.job.id })
    // Both surfaces that reported this job — the alert stream and the autonomy
    // scan — are settled with the operator's own decision.
    expect(closedAlerts.data.result).toHaveLength(2)
    expect(closedAlerts.data.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PUBLISH_DELIVERY_RECONCILIATION_REQUIRED', status: 'acknowledged', acknowledgedBy: expect.any(String), acknowledgementReason: expect.stringContaining('关闭对账') }),
      expect.objectContaining({ code: 'AUTOMATION_PUBLISH_ATTENTION', status: 'acknowledged', acknowledgementReason: expect.stringContaining('关闭对账') }),
    ]))
    const settledScan = await call(base, workspaceId, 'automation.scan', {})
    expect(settledScan.data.result.risks.filter((risk: { publish_job_id?: string }) => risk.publish_job_id === drift.job.id)).toEqual([])
  })
})
