#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createServer, createConnection } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SERVICE = 'com.storenova.merchant-mcp'
const MAX_REQUEST_BYTES = 1024 * 1024
const directory = resolve(homedir(), 'Library', 'Application Support', 'Store Nova', 'credential-broker')
export const DEFAULT_KEYCHAIN_BROKER_SOCKET = resolve(directory, 'v1.sock')

function qaBrokerSocket() {
  const configured = process.env.STORENOVA_QA_BROKER_SOCKET?.trim()
  if (!configured) return DEFAULT_KEYCHAIN_BROKER_SOCKET
  if (!configured.startsWith('/') || configured.length > 1024) throw new Error('KEYCHAIN_BROKER_SOCKET_INVALID')
  return resolve(configured)
}

export function createSeededMemoryHelper(seed) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed) || seed.schema_version !== '1'
    || !Array.isArray(seed.credentials) || seed.credentials.length < 1 || seed.credentials.length > 16
    || Object.keys(seed).sort().join(',') !== 'credentials,schema_version') throw new Error('KEYCHAIN_BROKER_SEED_INVALID')
  const records = new Map()
  for (const credential of seed.credentials) {
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)
      || Object.keys(credential).sort().join(',') !== 'account,data'
      || !/^[a-f0-9]{64}$/u.test(credential.account ?? '') || typeof credential.data !== 'string'
      || Buffer.byteLength(credential.data) > MAX_REQUEST_BYTES) throw new Error('KEYCHAIN_BROKER_SEED_INVALID')
    records.set(credential.account, credential.data)
  }
  return request => {
    validateBrokerRequest(request)
    if (request.operation === 'read') {
      if (!records.has(request.account)) throw new Error('KEYCHAIN_BROKER_CREDENTIAL_MISSING')
      return records.get(request.account)
    }
    if (request.operation === 'read_optional') return records.get(request.account) ?? 'null'
    if (request.operation === 'write') { records.set(request.account, request.data); return '' }
    throw new Error('KEYCHAIN_BROKER_REQUEST_INVALID')
  }
}

function safeDirectory(path = dirname(DEFAULT_KEYCHAIN_BROKER_SOCKET)) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('KEYCHAIN_BROKER_DIRECTORY_INVALID')
  chmodSync(path, 0o700)
}

export function validateBrokerRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('KEYCHAIN_BROKER_REQUEST_INVALID')
  const keys = Object.keys(value).sort()
  if (value.operation === 'ping') {
    if (keys.length !== 1 || keys[0] !== 'operation') throw new Error('KEYCHAIN_BROKER_REQUEST_INVALID')
    return { operation: 'ping' }
  }
  if (!['read', 'read_optional', 'write'].includes(value.operation)
    || value.service !== SERVICE || !/^[a-f0-9]{64}$/u.test(value.account ?? '')) throw new Error('KEYCHAIN_BROKER_REQUEST_INVALID')
  const expected = value.operation === 'write' ? ['account', 'data', 'operation', 'service'] : ['account', 'operation', 'service']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || value.operation === 'write' && (typeof value.data !== 'string' || Buffer.byteLength(value.data) > MAX_REQUEST_BYTES)) {
    throw new Error('KEYCHAIN_BROKER_REQUEST_INVALID')
  }
  return value
}

function runKeychainHelper(request, { helper = fileURLToPath(new URL('./keychain-credential-helper', import.meta.url)), spawnHelper = spawnSync } = {}) {
  const result = spawnHelper(helper, [], { input: JSON.stringify(request), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: request.operation === 'write' ? 120_000 : 8_000, maxBuffer: MAX_REQUEST_BYTES })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_REQUEST_BYTES) {
    throw new Error('KEYCHAIN_BROKER_OPERATION_FAILED')
  }
  return result.stdout
}

export function createKeychainBroker({ socketPath = DEFAULT_KEYCHAIN_BROKER_SOCKET, runHelper = runKeychainHelper } = {}) {
  safeDirectory(dirname(socketPath))
  if (existsSync(socketPath)) throw new Error('KEYCHAIN_BROKER_SOCKET_EXISTS')
  const server = createServer(socket => {
    // macOS enforces the peer UID at the filesystem boundary: the parent
    // directory is 0700 and the socket is 0600, both owned by this UID.
    let size = 0
    const chunks = []
    socket.setTimeout(125_000, () => socket.destroy())
    socket.on('data', chunk => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) return socket.destroy()
      chunks.push(chunk)
    })
    socket.on('end', () => {
      try {
        const request = validateBrokerRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const response = request.operation === 'ping' ? { ok: true } : { ok: true, data: runHelper(request) }
        socket.end(`${JSON.stringify(response)}\n`)
      } catch { socket.end('{"ok":false,"error":"KEYCHAIN_BROKER_REQUEST_FAILED"}\n') }
    })
    socket.on('error', () => {})
  })
  let ownedSocket
  server.on('listening', () => {
    chmodSync(socketPath, 0o600)
    const stat = lstatSync(socketPath)
    ownedSocket = { dev: stat.dev, ino: stat.ino }
  })
  server.on('close', () => {
    try {
      const stat = lstatSync(socketPath)
      // A later QA login may have replaced this pathname with a new broker.
      // Only remove the exact socket inode created by this server; otherwise an
      // old process exiting can make the replacement broker unreachable.
      if (ownedSocket && stat.isSocket() && stat.uid === process.getuid?.()
        && stat.dev === ownedSocket.dev && stat.ino === ownedSocket.ino) unlinkSync(socketPath)
    } catch {}
  })
  return server
}

export function requestKeychainBroker(request, { socketPath = DEFAULT_KEYCHAIN_BROKER_SOCKET, timeoutMs = 10_000 } = {}) {
  validateBrokerRequest(request)
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      error ? reject(error) : resolvePromise(value)
    }
    let stat
    try {
      const parent = lstatSync(dirname(socketPath))
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
        return finish(new Error('KEYCHAIN_BROKER_UNTRUSTED'))
      }
      stat = lstatSync(socketPath)
    } catch { return finish(new Error('KEYCHAIN_BROKER_UNAVAILABLE')) }
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return finish(new Error('KEYCHAIN_BROKER_UNTRUSTED'))
    const socket = createConnection(socketPath)
    const chunks = []
    let size = 0
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('KEYCHAIN_BROKER_TIMEOUT')))
    socket.on('connect', () => socket.end(JSON.stringify(request)))
    socket.on('data', chunk => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) return socket.destroy(new Error('KEYCHAIN_BROKER_RESPONSE_INVALID'))
      chunks.push(chunk)
    })
    socket.on('error', error => finish(error))
    socket.on('end', () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (response?.ok !== true || request.operation !== 'ping' && typeof response.data !== 'string') throw new Error('KEYCHAIN_BROKER_RESPONSE_INVALID')
        finish(undefined, request.operation === 'ping' ? '' : response.data)
      } catch (error) { finish(error) }
    })
  })
}

export async function startKeychainBrokerDetached({ socketPath = DEFAULT_KEYCHAIN_BROKER_SOCKET, spawnProcess = spawn } = {}) {
  try { await requestKeychainBroker({ operation: 'ping' }, { socketPath, timeoutMs: 500 }) ; return }
  catch {}
  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath)
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('KEYCHAIN_BROKER_SOCKET_INVALID')
    // A failed ping cannot distinguish a dead socket from a live but delayed
    // broker. Replacing it could orphan a process that still serves requests.
    throw new Error('KEYCHAIN_BROKER_UNAVAILABLE')
  }
  const child = spawnProcess(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore' })
  child.unref()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    try { await requestKeychainBroker({ operation: 'ping' }, { socketPath, timeoutMs: 250 }); return }
    catch {}
  }
  throw new Error('KEYCHAIN_BROKER_START_FAILED')
}

/** QA-only bridge for hosts whose background bootstrap domain cannot read the login Keychain.
 * The credential is delivered once over stdin and is never placed in argv, env, a file, or logs. */
export async function startSeededKeychainBrokerDetached({ credentials, socketPath = DEFAULT_KEYCHAIN_BROKER_SOCKET,
  spawnProcess = spawn } = {}) {
  const seed = { schema_version: '1', credentials }
  // Validate before replacing a live broker. This also caps the stdin payload.
  createSeededMemoryHelper(seed)
  try {
    await requestKeychainBroker({ operation: 'ping' }, { socketPath, timeoutMs: 500 })
    // Reuse a healthy broker and rotate its in-memory records through the same
    // private IPC path. This avoids orphaning the old listener by unlinking its
    // pathname while it is still alive.
    for (const credential of credentials) {
      await requestKeychainBroker({ operation: 'write', service: SERVICE, ...credential }, { socketPath, timeoutMs: 125_000 })
    }
    return
  } catch {}
  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath)
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('KEYCHAIN_BROKER_SOCKET_INVALID')
    // Keep startup fail-closed when the existing endpoint is unresponsive.
    // Only remove a stale socket after an operator has confirmed its owner is gone.
    throw new Error('KEYCHAIN_BROKER_UNAVAILABLE')
  }
  const child = spawnProcess(process.execPath, [fileURLToPath(import.meta.url), '--serve-seeded'], {
    detached: true, stdio: ['pipe', 'ignore', 'ignore'],
    // Keep the environment secret-free while passing the selected QA socket
    // explicitly. This makes isolated launchers and packaged login processes
    // agree on the same endpoint without putting credentials in argv or env.
    env: { STORENOVA_QA_BROKER_SOCKET: socketPath },
  })
  if (!child.stdin || typeof child.stdin.end !== 'function') throw new Error('KEYCHAIN_BROKER_START_FAILED')
  child.stdin.end(JSON.stringify(seed))
  child.stdin.unref?.()
  child.unref?.()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    try { await requestKeychainBroker({ operation: 'ping' }, { socketPath, timeoutMs: 250 }); return }
    catch {}
  }
  throw new Error('KEYCHAIN_BROKER_START_FAILED')
}

async function main() {
  if (process.argv.length !== 3) throw new Error('KEYCHAIN_BROKER_ARGUMENTS_INVALID')
  if (process.argv[2] === '--serve') {
    const socketPath = qaBrokerSocket()
    const server = createKeychainBroker({ socketPath })
    await new Promise((resolvePromise, reject) => server.listen(socketPath, error => error ? reject(error) : resolvePromise()))
    // A detached broker may outlive the terminal/installer that launched it.
    // Ignore only SIGHUP; explicit termination still closes the owned socket.
    process.on('SIGHUP', () => {})
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close())
    return
  }
  if (process.argv[2] === '--serve-seeded') {
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) throw new Error('KEYCHAIN_BROKER_SEED_INVALID')
      chunks.push(chunk)
    }
    const runHelper = createSeededMemoryHelper(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const socketPath = qaBrokerSocket()
    const server = createKeychainBroker({ runHelper, socketPath })
    await new Promise((resolvePromise, reject) => server.listen(socketPath, error => error ? reject(error) : resolvePromise()))
    process.on('SIGHUP', () => {})
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close())
    return
  }
  if (process.argv[2] === '--client') {
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) throw new Error('KEYCHAIN_BROKER_REQUEST_INVALID')
      chunks.push(chunk)
    }
    const request = validateBrokerRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    process.stdout.write(await requestKeychainBroker(request, { socketPath: qaBrokerSocket(), timeoutMs: request.operation === 'write' ? 125_000 : 10_000 }))
    return
  }
  throw new Error('KEYCHAIN_BROKER_ARGUMENTS_INVALID')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('KEYCHAIN_BROKER_FAILED\n'); process.exitCode = 1 })
}
