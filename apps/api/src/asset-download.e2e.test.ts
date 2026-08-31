import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Envelope = {
  data: unknown
  error: { code: string; message: string } | null
}

let assetRoot = ''
let base = ''
let server: typeof import('./server.js').server

async function json(response: Response) {
  return await response.json() as Envelope
}

describe('asset download durability boundary', () => {
  beforeAll(async () => {
    assetRoot = await mkdtemp(join(tmpdir(), 'merchant-asset-download-'))
    vi.stubEnv('ASSET_STORAGE_ROOT', assetRoot)
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    ;({ server } = await import('./server.js'))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(assetRoot, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('serves present bytes and returns a typed non-500 response when persisted metadata outlives them', async () => {
    const workspaceId = `ws_asset_download_${Date.now()}`
    const bytes = new TextEncoder().encode('container-compatible asset bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const headers = { 'x-workspace-id': workspaceId }
    const upload = await fetch(`${base}/v1/assets/upload`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain', 'x-asset-name': 'proof.txt', 'x-asset-sha256': sha256 },
      body: bytes,
    }).then(json)
    expect(upload.error).toBeNull()
    const uploaded = upload.data as { id: string; storageKey: string }
    const promoted = await fetch(`${base}/v1/assets/${uploaded.id}/scan`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ scan_evidence_ref: 'scanner://asset-download-test' }),
    }).then(json)
    expect(promoted.error).toBeNull()
    const clean = promoted.data as { storageKey: string }

    const present = await fetch(`${base}/v1/assets/${uploaded.id}/download`, { headers })
    expect(present.status).toBe(200)
    expect(present.headers.get('content-type')).toBe('text/plain')
    expect(new Uint8Array(await present.arrayBuffer())).toEqual(bytes)

    await rm(join(assetRoot, clean.storageKey))
    const missingResponse = await fetch(`${base}/v1/assets/${uploaded.id}/download`, { headers })
    const missing = await json(missingResponse)
    expect(missingResponse.status).toBe(410)
    expect(missing.error).toEqual({ code: 'ASSET_BINARY_UNAVAILABLE', message: '素材文件不可用，请重新上传' })
    expect(JSON.stringify(missing)).not.toContain(assetRoot)
    expect(JSON.stringify(missing)).not.toContain(clean.storageKey)
  })
})
