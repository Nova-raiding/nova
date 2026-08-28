import assert from 'node:assert/strict'
import { MerchantService, type Product } from '../packages/application/src/service.js'

const service = new MerchantService()
const total = 50
for (let index = 0; index < total; index += 1) {
  const product: Product = { id: `prod_load_${index}`, workspaceId: `ws_load_${index}`, platform: 'taobao', storeName: `店铺 ${index}`, remoteId: `TB-LOAD-${index}`, title: `测试商品 ${index}`, skuCount: 2, stock: 100, factsConfirmed: true, source: 'fixture', updatedAt: new Date().toISOString() }
  service.products.set(product.id, product)
}

const jobs = await Promise.all(Array.from({ length: total }, async (_, index) => {
  const workspaceId = `ws_load_${index}`
  const task = service.createTask({ workspaceId, productId: `prod_load_${index}`, platform: 'taobao' })
  service.selectDirection(task.id, 'A')
  const content = service.createDraft(task.id)
  service.approveContent(task.id, content.id)
  const preview = service.preparePublish(task.id)
  return service.confirmPublish({ workspaceId, taskId: task.id, contentVersionId: content.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: `load-${index}` })
}))

assert.equal(jobs.length, total)
assert.equal(new Set(jobs.map(job => job.id)).size, total)
assert.ok(jobs.every(job => job.state === 'queued'))
assert.equal(service.listPublishJobs('ws_load_0').length, 1)
assert.equal(service.listPublishJobs('ws_load_49').length, 1)
console.log(JSON.stringify({ profile: 'pilot_50_fake_in_memory', transport: 'in_memory_service', connectorMode: 'fake', cloudGate: false, workspaces: total, acceptedPublishJobs: jobs.length, duplicatePublishJobs: 0, duplicateWrites: 0, errors: [], status: 'pass' }))
