import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseClamAvScanResponse } from '../apps/worker/src/clamav-scanner.js'
import { executeAssetScan } from '../apps/worker/src/main.js'
import { MemoryAssetScanAttemptRepository } from '../packages/persistence/src/asset-scan-attempt-repository.js'
import type { DurableOutboxEvent } from '../packages/workers/src/durable.js'

const script = 'infra/scripts/verify-clamav-stream-boundary.sh'

describe('isolated ClamAV daemon boundary acceptance contract', () => {
  it('keeps the runtime check pinned to both deployed images and the 100 MiB transport boundary', () => {
    const source = readFileSync(script, 'utf8')
    const compose = readFileSync('infra/local/docker-compose.yml', 'utf8')
    const kubernetes = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
    for (const image of source.matchAll(/image='([^']+)'/gu)) {
      expect(`${compose}\n${kubernetes}`).toContain(image[1])
    }
    expect(source).toContain('clamdscan --stream /tmp/scan-100m.bin')
    expect(source).toContain('boundary_bytes=104857600')
    expect(source).toContain('CLAMD_CONF_AlertExceedsMax=yes')
    expect(source).toContain('expanded_limit=blocked')
    expect(source).toContain('container_auto_removed=true shared_containers_touched=false')
    expect(source).toContain('docker run --rm --name')
    expect(source).not.toMatch(/(?:--mount|--volume|\s-v\s|docker (?:restart|stop|kill|rm))\b/u)
    expect(execFileSync('sh', ['-n', script], { encoding: 'utf8' })).toBe('')
  })

  it('rejects an unsupported target before invoking Docker', () => {
    expect(() => execFileSync('sh', [script, 'shared-production'], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/usage:/)
  })

  it('turns a clamd expanded-limit FOUND response into signed blocked evidence, never clean admission', async () => {
    const signature = 'Heuristics.Limits.Exceeded.MaxScanSize'
    const result = parseClamAvScanResponse(`stream: ${signature} FOUND`)
    expect(result).toMatchObject({ status: 'infected', signature })
    const bytes = Buffer.from('isolated expanded-limit regression fixture')
    const objectKey = 'quarantine/ws_limit/asset_limit/source.gz'
    const now = new Date()
    const published = new Date(now.getTime() - 60 * 60_000)
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][published.getUTCDay()]
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][published.getUTCMonth()]
    const time = published.toISOString().slice(11, 19)
    const version = `ClamAV 1.4.6/28108/${weekday} ${month} ${published.getUTCDate()} ${time} ${published.getUTCFullYear()}`
    const event: DurableOutboxEvent = { id: 'evt_limit', workspaceId: 'ws_limit', aggregateId: 'asset_limit', eventType: 'asset.uploaded', sequence: 1, payload: { asset_id: 'asset_limit', storage_key: objectKey, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.byteLength }, createdAt: now.toISOString() }
    const repository = new MemoryAssetScanAttemptRepository()
    let callback: { receipt: { scan: { verdict: string; findings: string[] } } } | undefined
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/scan-content')) return new Response(bytes, { status: 200, headers: { 'content-type': 'application/gzip', 'x-asset-source-revision': '1', 'x-asset-object-key': encodeURIComponent(objectKey) } })
      callback = JSON.parse(String(init?.body)) as typeof callback
      return new Response(JSON.stringify({ data: { accepted: true }, error: null }), { status: 200 })
    }
    await expect(executeAssetScan({ apiBaseUrl: 'http://api:8787', apiToken: 'isolated-token', apiSigningSecret: 'isolated-secret', receiptPrivateKeyPem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), receiptKeyId: 'key-limit', scannerServiceId: 'scanner-limit', scannerInstanceId: 'instance-limit', policyVersion: 'limit-policy-v1', clamavHost: 'clamav', clamavPort: 3310, clamavTimeoutMs: 1000, attemptRepository: repository, scanner: { version: async () => version, scan: async () => result }, event, fetcher, now: () => now })).resolves.toMatchObject({ verdict: 'malicious' })
    expect(callback?.receipt.scan).toMatchObject({ verdict: 'malicious', findings: [signature] })
    expect((await repository.getByOutboxEvent('ws_limit', event.id))?.receipt.scan.verdict).toBe('malicious')
  })
})
