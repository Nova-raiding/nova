/**
 * Build first: npm run build:packages
 * (Building @merchant-marketing/persistence alone is no longer enough: it now
 * declares @merchant-marketing/storage as a dependency and resolves the
 * reservation-key derivation through the published export rather than a
 * relative path into storage's src, so storage's dist must exist first.)
 * Then: node scripts/verify-customer-delivery-video-actor.mjs
 * Exercises the built package export, not a source-file import or Vitest mock.
 * Scope: in-memory record attribution only. No upload, scanner, API, DB or grant.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = ['packages/persistence/src/customer-delivery-repository.ts',
  'packages/persistence/src/customer-delivery-repository.test.ts',
  'packages/persistence/dist/customer-delivery-repository.js',
  'packages/persistence/dist/index.js', 'scripts/verify-customer-delivery-video-actor.mjs']
const fingerprints = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')],
)))

export async function verifyCustomerDeliveryVideoActor() {
  const before = await fingerprints(), startedAt = new Date().toISOString()
  const observations = [], errors = []
  let after
  try {
    const { MemoryCustomerDeliveryRepository } = await import('@merchant-marketing/persistence/dist/index.js')
    const audits = [], repository = new MemoryCustomerDeliveryRepository(async event => { audits.push(event) })
    const workspaceId = `ws_video_actor_${randomUUID()}`
    const draft = await repository.create({ workspaceId, companyName: '隔离内存更新人验收', actorId: 'fixture-creator' })
    const check = async (stage, actorId, revision) => {
      const detail = await repository.get(workspaceId, draft.id)
      const listed = (await repository.list(workspaceId)).find(row => row.id === draft.id)
      observations.push({ stage, expectedActorId: actorId, actorId: detail?.updatedByActorId,
        listActorId: listed?.updatedByActorId, auditActorId: audits.at(-1)?.actorId,
        auditAction: audits.at(-1)?.action, revision: detail?.revision })
      assert.equal(detail?.updatedByActorId, actorId, 'VIDEO_ACTOR_DETAIL_MISMATCH')
      assert.equal(listed?.updatedByActorId, actorId, 'VIDEO_ACTOR_LIST_MISMATCH')
      assert.equal(audits.at(-1)?.actorId, actorId, 'VIDEO_ACTOR_AUDIT_MISMATCH')
      assert.equal(detail?.revision, revision, 'VIDEO_ACTOR_REVISION_MISMATCH')
      assert.equal(detail?.createdByActorId, 'fixture-creator', 'VIDEO_ACTOR_CREATOR_CHANGED')
      assert.equal(detail?.paymentStatus, 'unpaid', 'VIDEO_ACTOR_PAYMENT_CHANGED')
      assert.equal(detail?.effectiveAt, null, 'VIDEO_ACTOR_DRAFT_ACTIVATED')
      return detail
    }
    await check('create', 'fixture-creator', 1)
    const video = await repository.addVideo({ workspaceId, deliveryId: draft.id, actorId: 'fixture-uploader',
      title: '仅仓储引用，不是已扫描视频', assetRef: 'asset_reference_only_no_upload' })
    await check('add-video', 'fixture-uploader', 2)
    assert.equal(video.uploadedByActorId, 'fixture-uploader')
    assert.equal(audits.at(-1)?.action, 'customer_delivery.video.add')
    await repository.removeVideo({ workspaceId, deliveryId: draft.id, videoId: video.id, actorId: 'fixture-remover' })
    const removed = await check('remove-video', 'fixture-remover', 3)
    assert.equal(audits.at(-1)?.action, 'customer_delivery.video.remove')
    const auditCount = audits.length
    await repository.removeVideo({ workspaceId, deliveryId: draft.id, videoId: video.id, actorId: 'fixture-retry' })
    assert.deepEqual(await repository.get(workspaceId, draft.id), removed, 'VIDEO_ACTOR_REPLAY_CHANGED_RECORD')
    assert.equal(audits.length, auditCount, 'VIDEO_ACTOR_REPLAY_DUPLICATED_AUDIT')
    observations.push({ stage: 'repeat-remove', recordUnchanged: true, auditUnchanged: true })
    await assert.rejects(repository.removeVideo({ workspaceId: `${workspaceId}_other`, deliveryId: draft.id,
      videoId: video.id, actorId: 'fixture-foreign' }), { code: 'NOT_FOUND' })
    assert.deepEqual(await repository.get(workspaceId, draft.id), removed, 'VIDEO_ACTOR_CROSS_TENANT_CHANGED_RECORD')
    assert.equal(audits.length, auditCount)
    observations.push({ stage: 'foreign-tenant-remove', code: 'NOT_FOUND', recordUnchanged: true })
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'VIDEO_ACTOR_VERIFICATION_FAILED')
  } finally {
    after = await fingerprints()
    if (JSON.stringify(before) !== JSON.stringify(after)) errors.push('VIDEO_ACTOR_SOURCE_CHANGED_DURING_RUN')
  }
  const parent = join(root, 'artifacts/customer-delivery-video-actor')
  await mkdir(parent, { recursive: true })
  const evidenceDir = await mkdtemp(join(parent, 'run-'))
  const result = { status: errors.length ? 'failed' : 'passed', startedAt, endedAt: new Date().toISOString(),
    surface: 'built-package-export', observations, errors, sourceFingerprints: { before, after },
    memoryOnly: true, uploadedFiles: 0, scannedFiles: 0, apiRequests: 0, databaseWrites: 0, accountActivations: 0 }
  const report = join(evidenceDir, 'run-result.json')
  await writeFile(report, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ status: result.status, observations: observations.length, report }))
  return errors.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await verifyCustomerDeliveryVideoActor() }
  catch (error) { console.error(error instanceof Error ? error.message : 'VIDEO_ACTOR_VERIFICATION_FAILED'); process.exitCode = 1 }
}
