import { createConnection, type Socket } from 'node:net'
import type { Readable } from 'node:stream'

export interface ClamAvScannerOptions {
  host: string
  port: number
  timeoutMs?: number
  maxResponseBytes?: number
  chunkSizeBytes?: number
}

export type ClamAvScanResult =
  | { status: 'clean'; target: string; raw: string }
  | { status: 'infected'; target: string; signature: string; raw: string }
  | { status: 'error'; target: string; message: string; raw: string }

export type ClamAvScannerErrorCode =
  | 'CLAMAV_CONNECTION_ERROR'
  | 'CLAMAV_TIMEOUT'
  | 'CLAMAV_RESPONSE_TOO_LARGE'
  | 'CLAMAV_PROTOCOL_ERROR'
  | 'CLAMAV_INPUT_ERROR'

export class ClamAvScannerError extends Error {
  readonly code: ClamAvScannerErrorCode
  readonly cause?: unknown

  constructor(code: ClamAvScannerErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'ClamAvScannerError'
    this.code = code
    this.cause = cause
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024
const MAX_UINT32 = 0xffff_ffff

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function protocolError(message: string): ClamAvScannerError {
  return new ClamAvScannerError('CLAMAV_PROTOCOL_ERROR', message)
}

function normalizeInput(input: Buffer | Uint8Array | Readable): AsyncIterable<Uint8Array> {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return (async function* () { yield input })()
  }
  if (input && typeof input[Symbol.asyncIterator] === 'function') return input
  throw new TypeError('scan input must be a Buffer, Uint8Array, or Readable stream')
}

async function write(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (socket.destroyed) throw new ClamAvScannerError('CLAMAV_CONNECTION_ERROR', 'clamd connection closed while writing')
  if (socket.write(bytes)) return
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error('clamd connection closed while writing')) }
    const cleanup = () => {
      socket.off('drain', onDrain)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.once('drain', onDrain)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

export function parseClamAvScanResponse(raw: string): ClamAvScanResult {
  if (raw.length === 0 || raw.includes('\0') || raw.includes('\r') || raw.includes('\n')) {
    throw protocolError('clamd returned an empty or malformed scan response')
  }

  const clean = /^([^:]+): OK$/.exec(raw)
  if (clean) return { status: 'clean', target: clean[1]!, raw }

  const infected = /^([^:]+): (.+) FOUND$/.exec(raw)
  if (infected && infected[2]!.trim().length > 0) {
    return { status: 'infected', target: infected[1]!, signature: infected[2]!, raw }
  }

  const error = /^([^:]+): (.+) ERROR$/.exec(raw)
  if (error && error[2]!.trim().length > 0) {
    return { status: 'error', target: error[1]!, message: error[2]!, raw }
  }

  const instreamError = /^(INSTREAM) (.+) ERROR$/.exec(raw)
  if (instreamError && instreamError[2]!.trim().length > 0) {
    return { status: 'error', target: instreamError[1]!, message: instreamError[2]!, raw }
  }

  throw protocolError(`clamd returned an unrecognized scan response: ${JSON.stringify(raw)}`)
}

export class ClamAvScanner {
  readonly host: string
  readonly port: number
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly chunkSizeBytes: number

  constructor(options: ClamAvScannerOptions) {
    if (!options.host?.trim()) throw new TypeError('host must be non-empty')
    this.host = options.host
    this.port = positiveInteger(options.port, 'port')
    if (this.port > 65_535) throw new TypeError('port must be at most 65535')
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes')
    this.chunkSizeBytes = positiveInteger(options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES, 'chunkSizeBytes')
    if (this.chunkSizeBytes > MAX_UINT32) throw new TypeError('chunkSizeBytes must be at most 4294967295')
  }

  async ping(): Promise<void> {
    const response = await this.request(async socket => { await write(socket, Buffer.from('zPING\0', 'ascii')) })
    if (response !== 'PONG') throw protocolError(`clamd PING returned ${JSON.stringify(response)} instead of "PONG"`)
  }

  async version(): Promise<string> {
    const response = await this.request(async socket => { await write(socket, Buffer.from('zVERSION\0', 'ascii')) })
    if (!/^ClamAV [^/\s]+\/\d+\/[\x20-\x7e]+$/.test(response)) {
      throw protocolError(`clamd returned a malformed VERSION response: ${JSON.stringify(response)}`)
    }
    return response
  }

  async scan(input: Buffer | Uint8Array | Readable): Promise<ClamAvScanResult> {
    const response = await this.request(async socket => {
      await write(socket, Buffer.from('zINSTREAM\0', 'ascii'))
      try {
        for await (const sourceChunk of normalizeInput(input)) {
          const chunk = Buffer.from(sourceChunk)
          for (let offset = 0; offset < chunk.length; offset += this.chunkSizeBytes) {
            const body = chunk.subarray(offset, Math.min(offset + this.chunkSizeBytes, chunk.length))
            const header = Buffer.allocUnsafe(4)
            header.writeUInt32BE(body.length)
            await write(socket, header)
            await write(socket, body)
          }
        }
      } catch (cause) {
        if (cause instanceof ClamAvScannerError) throw cause
        throw new ClamAvScannerError('CLAMAV_INPUT_ERROR', 'failed to read scan input', cause)
      }
      await write(socket, Buffer.alloc(4))
    })
    return parseClamAvScanResponse(response)
  }

  private request(send: (socket: Socket) => Promise<void>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port })
      const chunks: Buffer[] = []
      let responseBytes = 0
      let settled = false

      const finish = (error?: unknown, response?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeAllListeners()
        socket.destroy()
        if (error) reject(error)
        else resolve(response!)
      }

      const timer = setTimeout(() => {
        finish(new ClamAvScannerError('CLAMAV_TIMEOUT', `clamd operation timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      timer.unref?.()

      socket.on('connect', () => {
        send(socket).catch(cause => {
          if (cause instanceof ClamAvScannerError) finish(cause)
          else finish(new ClamAvScannerError('CLAMAV_CONNECTION_ERROR', 'failed to write request to clamd', cause))
        })
      })
      socket.on('data', chunk => {
        const terminator = chunk.indexOf(0)
        const payload = terminator === -1 ? chunk : chunk.subarray(0, terminator)
        responseBytes += payload.length
        if (responseBytes > this.maxResponseBytes) {
          finish(new ClamAvScannerError('CLAMAV_RESPONSE_TOO_LARGE', `clamd response exceeded ${this.maxResponseBytes} bytes`))
          return
        }
        if (payload.length > 0) chunks.push(payload)
        if (terminator !== -1) {
          if (terminator !== chunk.length - 1) {
            finish(protocolError('clamd returned bytes after the NUL response terminator'))
            return
          }
          const bytes = Buffer.concat(chunks, responseBytes)
          const response = bytes.toString('utf8')
          if (!Buffer.from(response, 'utf8').equals(bytes)) {
            finish(protocolError('clamd returned a non-UTF-8 response'))
            return
          }
          finish(undefined, response)
        }
      })
      socket.on('error', cause => {
        finish(new ClamAvScannerError('CLAMAV_CONNECTION_ERROR', 'clamd connection failed', cause))
      })
      socket.on('close', () => {
        if (!settled) finish(protocolError('clamd closed the connection before the NUL response terminator'))
      })
    })
  }
}

export function createClamAvScanner(options: ClamAvScannerOptions): ClamAvScanner {
  return new ClamAvScanner(options)
}
