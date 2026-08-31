import { createServer, type Server, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClamAvScanner,
  ClamAvScannerError,
  parseClamAvScanResponse,
  type ClamAvScanResult,
} from './clamav-scanner.js'

const servers: Server[] = []
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
  })))
})

async function clamd(handler: (socket: Socket) => void): Promise<{ host: string; port: number }> {
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    handler(socket)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test clamd did not bind to TCP')
  return { host: '127.0.0.1', port: address.port }
}

function respondToCommand(expected: Buffer, response: string) {
  return (socket: Socket) => {
    const received: Buffer[] = []
    socket.on('data', chunk => {
      received.push(chunk)
      if (Buffer.concat(received).length >= expected.length) {
        expect(Buffer.concat(received)).toEqual(expected)
        socket.end(`${response}\0`)
      }
    })
  }
}

async function scanServer(response: string): Promise<{ endpoint: { host: string; port: number }; payload: Promise<Buffer>; frameLengths: number[] }> {
  let resolvePayload!: (value: Buffer) => void
  const payload = new Promise<Buffer>(resolve => { resolvePayload = resolve })
  const frameLengths: number[] = []
  const endpoint = await clamd(socket => {
    let buffered = Buffer.alloc(0)
    let commandRead = false
    const bodies: Buffer[] = []
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      if (!commandRead) {
        const command = Buffer.from('zINSTREAM\0', 'ascii')
        if (buffered.length < command.length) return
        expect(buffered.subarray(0, command.length)).toEqual(command)
        buffered = buffered.subarray(command.length)
        commandRead = true
      }
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) return
        buffered = buffered.subarray(4)
        frameLengths.push(length)
        if (length === 0) {
          expect(buffered).toHaveLength(0)
          resolvePayload(Buffer.concat(bodies))
          socket.end(`${response}\0`)
          return
        }
        bodies.push(buffered.subarray(0, length))
        buffered = buffered.subarray(length)
      }
    })
  })
  return { endpoint, payload, frameLengths }
}

describe('ClamAvScanner clamd protocol', () => {
  it('uses official NUL-terminated PING and VERSION commands', async () => {
    const pingEndpoint = await clamd(respondToCommand(Buffer.from('zPING\0'), 'PONG'))
    await expect(new ClamAvScanner(pingEndpoint).ping()).resolves.toBeUndefined()

    const versionEndpoint = await clamd(respondToCommand(Buffer.from('zVERSION\0'), 'ClamAV 1.4.2/27401/Fri Aug 30 09:30:00 2026'))
    await expect(new ClamAvScanner(versionEndpoint).version()).resolves.toBe('ClamAV 1.4.2/27401/Fri Aug 30 09:30:00 2026')
  })

  it('streams big-endian framed chunks followed by a zero-length frame', async () => {
    const fake = await scanServer('stream: OK')
    const scanner = new ClamAvScanner({ ...fake.endpoint, chunkSizeBytes: 3 })

    await expect(scanner.scan(Readable.from([Buffer.from('abc'), Buffer.from('defg')]))).resolves.toEqual({
      status: 'clean', target: 'stream', raw: 'stream: OK',
    })
    await expect(fake.payload).resolves.toEqual(Buffer.from('abcdefg'))
    expect(fake.frameLengths).toEqual([3, 3, 1, 0])
  })

  it.each<[string, ClamAvScanResult]>([
    ['stream: OK', { status: 'clean', target: 'stream', raw: 'stream: OK' }],
    ['stream: Eicar-Signature FOUND', { status: 'infected', target: 'stream', signature: 'Eicar-Signature', raw: 'stream: Eicar-Signature FOUND' }],
    ['stream: INSTREAM size limit exceeded ERROR', { status: 'error', target: 'stream', message: 'INSTREAM size limit exceeded', raw: 'stream: INSTREAM size limit exceeded ERROR' }],
    ['INSTREAM size limit exceeded. ERROR', { status: 'error', target: 'INSTREAM', message: 'size limit exceeded.', raw: 'INSTREAM size limit exceeded. ERROR' }],
  ])('strictly parses %s', (raw, expected) => {
    expect(parseClamAvScanResponse(raw)).toEqual(expected)
  })

  it.each(['', 'stream: MAYBE', 'stream: FOUND', 'stream:  FOUND', 'stream: OK\n', 'OK', 'stream: Eicar FOUND trailing'])(
    'rejects malformed scan response %j',
    raw => expect(() => parseClamAvScanResponse(raw)).toThrowError(ClamAvScannerError),
  )

  it('enforces one absolute timeout across the complete operation', async () => {
    const endpoint = await clamd(() => undefined)
    const scanner = new ClamAvScanner({ ...endpoint, timeoutMs: 30 })
    await expect(scanner.ping()).rejects.toMatchObject({ code: 'CLAMAV_TIMEOUT' })
  })

  it('rejects oversized and unterminated responses', async () => {
    const oversized = await clamd(socket => socket.end('123456789\0'))
    await expect(new ClamAvScanner({ ...oversized, maxResponseBytes: 8 }).ping()).rejects.toMatchObject({ code: 'CLAMAV_RESPONSE_TOO_LARGE' })

    const unterminated = await clamd(socket => socket.end('PONG'))
    await expect(new ClamAvScanner(unterminated).ping()).rejects.toMatchObject({ code: 'CLAMAV_PROTOCOL_ERROR' })
  })

  it('rejects malformed health responses and preserves connection error causes', async () => {
    const malformedPing = await clamd(respondToCommand(Buffer.from('zPING\0'), 'OK'))
    await expect(new ClamAvScanner(malformedPing).ping()).rejects.toMatchObject({ code: 'CLAMAV_PROTOCOL_ERROR' })

    const temporary = await clamd(() => undefined)
    const port = temporary.port
    await new Promise<void>(resolve => servers.pop()!.close(() => resolve()))
    await expect(new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 200 }).ping()).rejects.toMatchObject({ code: 'CLAMAV_CONNECTION_ERROR' })
  })
})
