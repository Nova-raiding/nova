import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDurableArchiveReference } from './archive-lifecycle-contract.js'
import { LocalObjectStorage } from './object-storage.js'

const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex')

describe('durable archive lifecycle contract', () => {
  it.each(['asset', 'generated_image', 'generated_video'] as const)('accepts a %s reference only with object metadata, hash and revision', kind => {
    const body = new TextEncoder().encode(`${kind}:archived`)
    expect(checkDurableArchiveReference({
      kind,
      workspaceId: 'ws_restore',
      entityId: `${kind}_1`,
      storageKey: `clean/ws_restore/${kind}_1/output.bin`,
      sha256: sha256(body),
      sizeBytes: body.byteLength,
      revision: 3,
    })).toEqual({ restorable: true, reasons: [] })
  })

  it('blocks provider-only video results from being called restorable', () => {
    expect(checkDurableArchiveReference({
      kind: 'generated_video',
      workspaceId: 'ws_restore',
      entityId: 'video_1',
      providerJobId: 'provider-job-1',
      url: 'https://provider.example/video.mp4',
      status: 'completed',
    })).toMatchObject({ restorable: false })
  })

  it('blocks fixture URIs, missing metadata, and invalid revisions', () => {
    expect(checkDurableArchiveReference({
      kind: 'generated_image', workspaceId: 'ws_restore', entityId: 'image_1',
      storageKey: 'fixture://ws_restore/image_1', sha256: '0'.repeat(64), sizeBytes: 0, revision: 0,
    })).toEqual({
      restorable: false,
      reasons: [
        'storageKey must be a workspace-scoped quarantine/clean object key',
        'sizeBytes must be positive',
        'revision must be positive',
      ],
    })
  })

  it('rejects traversal and non-portable archive keys', () => {
    const base = { kind: 'asset' as const, workspaceId: 'ws_restore', entityId: 'asset_1', sha256: '0'.repeat(64), sizeBytes: 1, revision: 1 }
    expect(checkDurableArchiveReference({ ...base, storageKey: 'clean/ws_restore/asset_1/../file' }).restorable).toBe(false)
    expect(checkDurableArchiveReference({ ...base, storageKey: 'clean/ws_restore/asset_1\\file' }).restorable).toBe(false)
  })

  it('requires both the durable snapshot reference and the object bytes at restore time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merchant-archive-restore-'))
    try {
      const store = new LocalObjectStorage(root)
      const body = new TextEncoder().encode('joint restore payload')
      const quarantine = await store.putQuarantine({ workspaceId: 'ws_restore', assetId: 'asset_joint', fileName: 'source.bin', contentType: 'application/octet-stream', body })
      const clean = await store.promoteClean({ workspaceId: 'ws_restore', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://joint-restore' })
      const snapshot = { kind: 'asset' as const, workspaceId: 'ws_restore', entityId: 'asset_joint', storageKey: clean.key, sha256: clean.sha256, sizeBytes: clean.sizeBytes, revision: 2 }

      expect(checkDurableArchiveReference(snapshot).restorable).toBe(true)
      await expect(store.get(snapshot.workspaceId, snapshot.storageKey)).resolves.toMatchObject({ body, metadata: expect.objectContaining({ sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes }) })
      await store.delete(snapshot.workspaceId, snapshot.storageKey)
      await expect(store.get(snapshot.workspaceId, snapshot.storageKey)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
