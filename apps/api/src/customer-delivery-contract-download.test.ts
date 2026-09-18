import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: network.request }))

import { downloadCustomerDeliveryContract } from './customer-delivery-contract-download.js'

const source = 'https://contracts.example.test/document?signature=secret'
const pdf = Buffer.from('%PDF-1.7\ncontract fixture')
const publicAddress = { address: '93.184.215.14', family: 4 }
type ResponseFixture = { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; complete?: boolean; hang?: boolean; noHeaders?: boolean; error?: Error }
type MockRequest = EventEmitter & { destroy: ReturnType<typeof vi.fn<(error?: Error) => unknown>>; end: () => void }
let requests: Array<{ options: RequestOptions; request: MockRequest; response?: IncomingMessage }>

function respond(fixture: ResponseFixture = {}) {
  network.request.mockImplementation((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as MockRequest
    const entry: typeof requests[number] = { options, request }
    requests.push(entry)
    request.destroy = vi.fn((error?: Error) => {
      queueMicrotask(() => { if (error) request.emit('error', error) })
      entry.response?.destroy()
      return request
    })
    options.signal?.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
    request.end = () => queueMicrotask(() => {
      if (fixture.error) { request.emit('error', fixture.error); return }
      if (fixture.noHeaders) return
      const response = (fixture.hang ? new Readable({ read() {} }) : Readable.from(fixture.chunks ?? [pdf])) as IncomingMessage
      response.statusCode = fixture.status ?? 200
      response.headers = { 'content-type': 'application/pdf', ...fixture.headers }
      response.complete = fixture.complete ?? true
      entry.response = response
      callback(response)
    })
    return request
  })
}

beforeEach(() => {
  requests = []
  network.lookup.mockReset().mockResolvedValue([publicAddress])
  network.request.mockReset()
  respond()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('contract URL download: isolated transport stubs, not scanner or public-network acceptance', () => {
  it('returns only server-derived upload bytes, safe name, MIME and digest', async () => {
    const digest = createHash('sha256').update(pdf).digest('hex')
    expect(await downloadCustomerDeliveryContract(source)).toEqual({ name: `contract-${digest.slice(0, 16)}.pdf`, mime_type: 'application/pdf', content_base64: pdf.toString('base64'), sha256: digest })
    expect(network.lookup).toHaveBeenCalledExactlyOnceWith('contracts.example.test', { all: true, verbatim: true })
    expect(requests[0]!.options).toMatchObject({ hostname: 'contracts.example.test', servername: 'contracts.example.test', family: 4, port: 443, method: 'GET', path: '/document?signature=secret', rejectUnauthorized: true })
    expect(requests[0]!.options.checkServerIdentity).toBeUndefined()
    expect(requests[0]!.options.headers).not.toHaveProperty('Authorization')
    expect(requests[0]!.options.headers).not.toHaveProperty('Cookie')
  })

  it.each([
    '', 'http://contracts.example.test/file', '//contracts.example.test/file', 'file:///etc/passwd',
    'https://user:password@contracts.example.test/file', 'https://@contracts.example.test/file',
    'https://contracts.example.test:8443/file', 'https://contracts.example.test/file#part', 'https://contracts.example.test/file#',
    'https://contracts.example.test/\\file', 'https://contracts.example.test/\r\nfile', 'https://contracts.example.test/%0d%0aheader',
    'https://localhost/file', 'https://localhost./file', 'https://foo.localhost/file', 'https://example.local/file', 'https://foo.internal/file',
    `https://contracts.example.test/${'a'.repeat(2000)}`,
  ])('rejects unsafe URL before DNS: %s', async url => {
    await expect(downloadCustomerDeliveryContract(url)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_URL_INVALID', status: 400 })
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
  })

  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '168.63.129.16', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:93.184.215.14', '0:0:0:0:0:ffff:7f00:1',
    '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::', '2001::1', '2001:db8::1', '3ffe::1', '3fff::1', '4000::1',
  ])('rejects a non-public DNS result: %s', async address => {
    network.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }])
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_URL_BLOCKED', status: 400 })
    expect(network.request).not.toHaveBeenCalled()
  })

  it.each(['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '%31%32%37.0.0.1', '[::ffff:7f00:1]', '[::1]'])('rejects encoded private literal %s without DNS', async host => {
    await expect(downloadCustomerDeliveryContract(`https://${host}/file`)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_URL_BLOCKED' })
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
  })

  it('rejects mixed public/private DNS answers, including a later address', async () => {
    network.lookup.mockResolvedValue([publicAddress, { address: '10.0.0.1', family: 4 }])
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_URL_BLOCKED' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it.each([{ answers: [] }, { answers: [{ address: 'invalid', family: 4 }] }, { answers: [{ address: '93.184.215.14', family: 6 }] }])('rejects empty or inconsistent DNS data', async ({ answers }) => {
    network.lookup.mockResolvedValue(answers)
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_URL_BLOCKED' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it('does not leak the source URL from DNS or TLS failures', async () => {
    network.lookup.mockRejectedValueOnce(new Error(`DNS failed ${source}`))
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_FAILED' })
    respond({ error: new Error(`certificate mismatch ${source}`) })
    const error = await downloadCustomerDeliveryContract(source).catch(error => error)
    expect(error.code).toBe('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_FAILED')
    expect(JSON.stringify(error) + error.message).not.toContain('signature=secret')
  })
  it('pins the checked address without another DNS query, and supports the lookup all callback shape', async () => {
    await downloadCustomerDeliveryContract(source)
    network.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const lookup = requests[0]!.options.lookup!
    const single = vi.fn()
    lookup('contracts.example.test', {}, single)
    expect(single).toHaveBeenCalledWith(null, publicAddress.address, 4)
    const all = vi.fn()
    lookup('contracts.example.test', { all: true }, all)
    expect(all).toHaveBeenCalledWith(null, [publicAddress])
    expect(network.lookup).toHaveBeenCalledTimes(1)
    const unexpected = vi.fn()
    lookup('different.example.test', {}, unexpected)
    expect(unexpected.mock.calls[0]![0]).toBeInstanceOf(Error)
  })
  it('uses a fresh explicit direct agent, even with proxy environment configured', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:8888')
    await downloadCustomerDeliveryContract(source)
    await downloadCustomerDeliveryContract(source)
    expect(requests[0]!.options.agent).not.toBe(requests[1]!.options.agent)
    expect(requests[0]!.options.agent).toMatchObject({ options: { keepAlive: false, maxCachedSessions: 0 } })
    expect(requests[0]!.options.agent).not.toHaveProperty('options.proxyEnv')
  })
  it('supports native public IPv6 while fixing that family', async () => {
    network.lookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }])
    await downloadCustomerDeliveryContract(source)
    expect(requests[0]!.options.family).toBe(6)
  })

  it.each([301, 302, 303, 307, 308])('rejects redirect %s without following Location', async status => {
    respond({ status, headers: { location: 'http://127.0.0.1/private' } })
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_REDIRECT_REJECTED' })
    expect(network.request).toHaveBeenCalledTimes(1)
    expect(requests[0]!.request.destroy).toHaveBeenCalled()
  })
  it.each([201, 204, 206, 304, 401, 403, 404, 500])('rejects non-200 response %s', async status => {
    respond({ status })
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: status >= 300 && status < 400 ? 'CUSTOMER_DELIVERY_CONTRACT_REDIRECT_REJECTED' : 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_FAILED' })
  })
  it.each(['text/html', 'application/octet-stream', 'application/zip', 'video/mp4', ''])('rejects unsupported response MIME %s', async mime => {
    respond({ headers: { 'content-type': mime } })
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_UPLOAD_TYPE_UNSUPPORTED' })
  })
  it.each(['gzip', 'br', 'deflate'])('does not decode compressed response %s', async encoding => {
    respond({ headers: { 'content-encoding': encoding } })
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_FAILED' })
  })
  it.each([
    ['application/pdf', Buffer.from('<html>Login to download</html>')],
    ['image/png', pdf],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf],
    ['application/pdf', Buffer.from('MZexecutable')],
  ])('rejects MIME/signature mismatch %s', async (mime, bytes) => {
    respond({ headers: { 'content-type': mime }, chunks: [bytes] })
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_UPLOAD_TYPE_UNSUPPORTED' })
  })
  it.each([
    ['image/png', 'png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/jpeg', 'jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ])('uses existing signature admission for %s; does not claim document parsing or scanning', async (mime, extension, bytes) => {
    respond({ headers: { 'content-type': `${mime}; charset=binary`, 'content-disposition': 'attachment; filename="../../untrusted.exe"' }, chunks: [bytes] })
    const result = await downloadCustomerDeliveryContract(source)
    expect(result.mime_type).toBe(mime)
    expect(result.name).toMatch(new RegExp(`^contract-[a-f0-9]{16}\\.${extension}$`))
    expect(result.content_base64).toBe(bytes.toString('base64'))
  })
  it.each(['0', '-1', 'not-a-length', '1.5', '52428801'])('rejects invalid or excessive content length %s', async length => {
    respond({ headers: { 'content-length': length } })
    await expect(downloadCustomerDeliveryContract(source)).rejects.toBeInstanceOf(Error)
    expect(requests[0]!.request.destroy).toHaveBeenCalled()
  })
  it('rejects empty, truncated and falsely sized bodies', async () => {
    for (const fixture of [{ chunks: [] }, { complete: false }, { headers: { 'content-length': '100' } }]) {
      respond(fixture)
      await expect(downloadCustomerDeliveryContract(source)).rejects.toBeInstanceOf(Error)
    }
  })
  it('enforces the streamed byte limit without relying on Content-Length', async () => {
    const megabyte = Buffer.alloc(1024 * 1024, 65)
    respond({ chunks: [pdf, ...Array.from({ length: 50 }, () => megabyte)] })
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_UPLOAD_SIZE_LIMIT', status: 413 })
    expect(requests[0]!.request.destroy).toHaveBeenCalled()
  })
  it('admits exactly 50 MiB with a matching declared length', async () => {
    const bytes = Buffer.alloc(50 * 1024 * 1024, 65)
    pdf.copy(bytes)
    respond({ headers: { 'content-length': String(bytes.length) }, chunks: [bytes] })
    const result = await downloadCustomerDeliveryContract(source)
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(Buffer.byteLength(result.content_base64, 'base64')).toBe(bytes.length)
  })

  it('does not start DNS or transport for an already cancelled operation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(downloadCustomerDeliveryContract(source, { signal: controller.signal })).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_CANCELLED' })
    expect(network.lookup).not.toHaveBeenCalled()
  })
  it('times out DNS within the same 40 second deadline and never connects after late resolution', async () => {
    vi.useFakeTimers()
    let resolveDns!: (value: typeof publicAddress[]) => void
    network.lookup.mockImplementation(() => new Promise(resolve => { resolveDns = resolve }))
    const result = downloadCustomerDeliveryContract(source).catch(error => error)
    await vi.advanceTimersByTimeAsync(40_001)
    expect(await result).toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_TIMEOUT', status: 504 })
    resolveDns([publicAddress])
    await Promise.resolve()
    expect(network.request).not.toHaveBeenCalled()
  })
  it('handles late DNS rejection after timeout and restores its permit without connecting', async () => {
    vi.useFakeTimers()
    let rejectDns!: (error: Error) => void
    network.lookup.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDns = reject }))
    const result = downloadCustomerDeliveryContract(source).catch(error => error)
    await vi.advanceTimersByTimeAsync(40_001)
    expect(await result).toHaveProperty('code', 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_TIMEOUT')
    rejectDns(new Error('late DNS failure'))
    await Promise.resolve()
    await Promise.resolve()
    expect(network.request).not.toHaveBeenCalled()
    await expect(downloadCustomerDeliveryContract(source)).resolves.toHaveProperty('sha256')
  })
  it('destroys a stalled response on the total deadline', async () => {
    vi.useFakeTimers()
    respond({ hang: true })
    const result = downloadCustomerDeliveryContract(source).catch(error => error)
    await vi.advanceTimersByTimeAsync(40_001)
    expect(await result).toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_TIMEOUT' })
    expect(requests[0]!.request.destroy).toHaveBeenCalled()
  })
  it('destroys a connection stalled before response headers on the same deadline', async () => {
    vi.useFakeTimers()
    respond({ noHeaders: true })
    const result = downloadCustomerDeliveryContract(source).catch(error => error)
    await vi.advanceTimersByTimeAsync(40_001)
    expect(await result).toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_TIMEOUT' })
    expect(requests[0]!.request.destroy).toHaveBeenCalled()
  })
  it('bounds uncancellable DNS work even after the user-facing requests time out', async () => {
    vi.useFakeTimers()
    let finishDns!: (value: typeof publicAddress[]) => void
    const heldDns = new Promise(resolve => { finishDns = resolve })
    network.lookup.mockReturnValue(heldDns)
    const first = downloadCustomerDeliveryContract(source).catch(error => error)
    const second = downloadCustomerDeliveryContract(source).catch(error => error)
    await vi.advanceTimersByTimeAsync(40_001)
    expect(await first).toHaveProperty('code', 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_TIMEOUT')
    expect(await second).toHaveProperty('code', 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_TIMEOUT')
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_BUSY' })
    expect(network.lookup).toHaveBeenCalledTimes(2)
    finishDns([publicAddress])
    await Promise.resolve()
    await Promise.resolve()
    expect(network.request).not.toHaveBeenCalled()
    await expect(downloadCustomerDeliveryContract(source)).resolves.toHaveProperty('sha256')
  })
  it('cancels an in-progress body and releases its concurrency slot', async () => {
    respond({ hang: true })
    const controller = new AbortController()
    const pending = downloadCustomerDeliveryContract(source, { signal: controller.signal }).catch(error => error)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    expect(await pending).toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_CANCELLED' })
    expect(requests[0]!.request.destroy).toHaveBeenCalled()
    respond()
    await expect(downloadCustomerDeliveryContract(source)).resolves.toHaveProperty('sha256')
  })
  it('admits only two concurrent downloads and rejects overload without DNS or queueing', async () => {
    let finishDns!: (value: typeof publicAddress[]) => void
    const heldDns = new Promise(resolve => { finishDns = resolve })
    network.lookup.mockReturnValue(heldDns)
    const first = downloadCustomerDeliveryContract(source)
    const second = downloadCustomerDeliveryContract(source)
    await expect(downloadCustomerDeliveryContract(source)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_BUSY', status: 503 })
    expect(network.lookup).toHaveBeenCalledTimes(2)
    finishDns([publicAddress])
    await Promise.all([first, second])
    await expect(downloadCustomerDeliveryContract(source)).resolves.toHaveProperty('sha256')
  })
})
