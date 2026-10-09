import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  acceptedPendingMaterialIds,
  appendPendingMaterialFiles,
  MAX_PENDING_MATERIAL_FILES,
  releasePreviewUrls,
  revokeObsoletePreviewUrls,
  removePendingMaterialFiles,
  uploadDialogCloseAllowed,
} from './material-upload-pending'
import { uploadMaterialFiles } from './material-library'
import type { AssetMetadata } from './api'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

const file = (name: string, content: string) => new File([content], name, { lastModified: 1, type: 'image/png' })

describe('pending material upload identity and limit', () => {
  it('keeps separate files with colliding name, size and modified time', () => {
    const first = file('same.png', 'aa')
    const second = file('same.png', 'bb')
    const result = appendPendingMaterialFiles([], [first, second], (() => {
      let next = 0
      return () => `pending-${++next}`
    })())

    expect(first.size).toBe(second.size)
    expect(first.lastModified).toBe(second.lastModified)
    expect(result.items.map((item) => item.id)).toEqual(['pending-1', 'pending-2'])
    expect(result.items.map((item) => item.file)).toEqual([first, second])
  })

  it('rejects an over-limit selection as a whole and preserves existing items', () => {
    const current = Array.from({ length: MAX_PENDING_MATERIAL_FILES - 1 }, (_, index) => ({ id: `existing-${index}`, file: file(`${index}.png`, 'x') }))
    const result = appendPendingMaterialFiles(current, [file('new-a.png', 'a'), file('new-b.png', 'b')])

    expect(result.items).toBe(current)
    expect(result.items).toHaveLength(MAX_PENDING_MATERIAL_FILES - 1)
    expect(result.notAdded).toBe(2)
  })

  it('deletes and clears accepted rows by unique identity', () => {
    const first = file('same.png', 'aa')
    const second = file('same.png', 'bb')
    const rows = [{ id: 'one', file: first }, { id: 'two', file: second }]

    expect(removePendingMaterialFiles(rows, ['one'])).toEqual([rows[1]])
    expect(acceptedPendingMaterialIds(rows, [first])).toEqual(new Set(['one']))
  })

  it('prevents closing the upload dialog while a request is in flight', () => {
    expect(uploadDialogCloseAllowed(true)).toBe(false)
    expect(uploadDialogCloseAllowed(false)).toBe(true)
    expect(appSource).toContain('if (!uploadDialogCloseAllowed(uploadBusy)) return')
    expect(appSource).toContain('onClose={closeUploadDialog}\n          busy={uploadBusy}')
    expect(appSource).toContain('className="catalog-asset-cancel" disabled={uploadBusy}')
  })

  it('releases accepted preview object URLs when rows leave the session or the workspace unmounts', () => {
    const revoked: string[] = []
    const previous = new Set(['blob:keep', 'blob:remove'])
    const live = revokeObsoletePreviewUrls(previous, new Set(['blob:keep']), (url) => revoked.push(url))
    expect(revoked).toEqual(['blob:remove'])
    expect(live).toEqual(new Set(['blob:keep']))

    releasePreviewUrls(live, (url) => revoked.push(url))
    expect(revoked).toEqual(['blob:remove', 'blob:keep'])
    expect(appSource).toContain('revokeObsoletePreviewUrls(ownedUploadPreviewUrls.current, current)')
    expect(appSource).toContain('releasePreviewUrls(ownedUploadPreviewUrls.current)')
  })

  it('keeps a confirmed server upload accepted when local preview allocation fails', async () => {
    const uploadCalls: string[] = []
    const outcome = await uploadMaterialFiles({
      files: [file('accepted.png', 'bytes')],
      upload: async (selected) => {
        uploadCalls.push(selected.name)
        return { id: 'asset-1', name: selected.name, mimeType: 'image/png', sizeBytes: selected.size } as AssetMetadata
      },
      labels: { category: '未分类', series: '未分类' },
      previewUrlFor: () => { throw new Error('blob allocation unavailable') },
    })

    expect(uploadCalls).toEqual(['accepted.png'])
    expect(outcome.accepted.map((item) => item.id)).toEqual(['asset-1'])
    expect(outcome.acceptedFiles).toHaveLength(1)
    expect(outcome.failures).toEqual([])
  })

  it('passes an abort signal and stops before starting the next file', async () => {
    const controller = new AbortController()
    const uploadCalls: string[] = []
    const outcome = await uploadMaterialFiles({
      files: [file('first.png', 'a'), file('second.png', 'b')],
      upload: async (selected, signal) => {
        expect(signal).toBe(controller.signal)
        uploadCalls.push(selected.name)
        controller.abort()
        return { id: 'asset-1', name: selected.name, mimeType: 'image/png', sizeBytes: selected.size } as AssetMetadata
      },
      labels: { category: '未分类', series: '未分类' },
      signal: controller.signal,
    })

    expect(uploadCalls).toEqual(['first.png'])
    expect(outcome.acceptedFiles.map((item) => item.name)).toEqual(['first.png'])
    expect(appSource).toContain('uploadControllerRef.current?.abort()')
    expect(appSource).toContain('upload: (file, signal) => uploadAsset(baseUrl, file, uploadCategory, signal)')
    expect(apiSource).toContain('body: await file.arrayBuffer(),\n  signal,')
  })
})
