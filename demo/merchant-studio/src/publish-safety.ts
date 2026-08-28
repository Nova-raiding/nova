export interface PublishEvidence {
  taskId: string
  contentVersionId: string
  accountId: string
  confirmationHash: string
  remoteSnapshotHash: string
}

export interface PublishSubmission {
  body: {
    task_id: string
    content_version_id: string
    account_id: string
    confirmation_hash: string
    remote_snapshot_hash: string
  }
  idempotencyKey: string
}

export interface PublishReceiptEvidence {
  id: string
  taskId: string
  contentVersionId: string
  accountId?: string
  confirmationHash: string
  remoteSnapshotHash: string
  idempotencyKey: string
}

const evidenceFields: Array<keyof PublishEvidence> = ['taskId', 'contentVersionId', 'accountId', 'confirmationHash', 'remoteSnapshotHash']

export function createPublishSubmission(evidence: PublishEvidence): PublishSubmission {
  const missing = evidenceFields.find(field => !evidence[field]?.trim())
  if (missing) throw new Error(`发布证据缺失：${missing}`)
  const idempotencyKey = `merchant-studio-publish-v1:${evidenceFields.map(field => encodeURIComponent(evidence[field])).join(':')}`
  return {
    body: {
      task_id: evidence.taskId,
      content_version_id: evidence.contentVersionId,
      account_id: evidence.accountId,
      confirmation_hash: evidence.confirmationHash,
      remote_snapshot_hash: evidence.remoteSnapshotHash,
    },
    idempotencyKey,
  }
}

export function validatePublishPreview(input: {
  expectedTaskId: string
  expectedContentVersionId: string
  expectedAccountId: string
  previewTaskId: string
  previewContentVersionId: string
  previewAccountId?: string
  confirmationHash: string
  remoteSnapshotHash: string
}): string | null {
  if (input.previewTaskId !== input.expectedTaskId) return '发布预览任务与当前审核任务不一致，已阻止发布。'
  if (input.previewContentVersionId !== input.expectedContentVersionId) return '发布预览内容版本与当前审核版本不一致，已阻止发布。'
  if (input.previewAccountId !== input.expectedAccountId) return '发布预览店铺账号与当前目标不一致，已阻止发布。'
  if (!input.confirmationHash.trim() || !input.remoteSnapshotHash.trim()) return '发布预览缺少确认哈希或远端快照哈希，已阻止发布。'
  return null
}

export function validatePublishReceipt(submission: PublishSubmission, receipt: PublishReceiptEvidence): string | null {
  if (!receipt.id.trim()) return '发布服务未返回任务 ID，无法确认请求已受理。'
  if (receipt.taskId !== submission.body.task_id) return '发布回执任务与本次确认不一致，未显示成功。'
  if (receipt.contentVersionId !== submission.body.content_version_id) return '发布回执内容版本与本次确认不一致，未显示成功。'
  if (receipt.accountId !== submission.body.account_id) return '发布回执店铺账号与本次确认不一致，未显示成功。'
  if (receipt.confirmationHash !== submission.body.confirmation_hash) return '发布回执确认哈希与本次确认不一致，未显示成功。'
  if (receipt.remoteSnapshotHash !== submission.body.remote_snapshot_hash) return '发布回执远端快照与本次确认不一致，未显示成功。'
  if (receipt.idempotencyKey !== submission.idempotencyKey) return '发布回执幂等键与本次确认不一致，未显示成功。'
  return null
}
