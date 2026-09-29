import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-ignore JavaScript runtime module
import { createKeychainBroker, createSeededMemoryHelper, requestKeychainBroker, startSeededKeychainBrokerDetached, validateBrokerRequest } from './keychain-broker.mjs'

const roots: string[] = []
const request = { operation: 'read', service: 'com.storenova.merchant-mcp', account: 'a'.repeat(64) }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('macOS Keychain GUI broker', () => {
  it('keeps a QA seed in memory and applies reads, optional reads, and rotations', () => {
    const account = 'a'.repeat(64)
    const other = 'b'.repeat(64)
    const helper = createSeededMemoryHelper({ schema_version: '1', credentials: [{ account, data: 'initial-secret' }] })
    expect(helper({ operation: 'read', service: 'com.storenova.merchant-mcp', account })).toBe('initial-secret')
    expect(helper({ operation: 'read_optional', service: 'com.storenova.merchant-mcp', account: other })).toBe('null')
    expect(helper({ operation: 'write', service: 'com.storenova.merchant-mcp', account, data: 'rotated-secret' })).toBe('')
    expect(helper({ operation: 'read', service: 'com.storenova.merchant-mcp', account })).toBe('rotated-secret')
    expect(() => helper({ operation: 'read', service: 'com.storenova.merchant-mcp', account: other })).toThrow('KEYCHAIN_BROKER_CREDENTIAL_MISSING')
  })

  it('injects a QA seed only through child stdin', async () => {
    const account = 'a'.repeat(64)
    const secret = 'access-and-refresh-secret'
    let invocation: any
    const spawnProcess = (command: string, args: string[], options: any) => {
      invocation = { command, args, options, stdin: '' }
      return { stdin: { end: (value: string) => { invocation.stdin = value }, unref: () => {} }, unref: () => {} }
    }
    await expect(startSeededKeychainBrokerDetached({ credentials: [{ account, data: secret }],
      socketPath: resolve(tmpdir(), `missing-${Date.now()}`, 'broker.sock'), spawnProcess })).rejects.toThrow('KEYCHAIN_BROKER_START_FAILED')
    expect(invocation.args).toEqual([expect.stringContaining('keychain-broker.mjs'), '--serve-seeded'])
    expect(JSON.stringify(invocation.args)).not.toContain(secret)
    expect(invocation.options.env).toEqual({ STORENOVA_QA_BROKER_SOCKET: expect.stringContaining('broker.sock') })
    expect(JSON.stringify(invocation.options.env)).not.toContain(secret)
    expect(invocation.stdin).toContain(secret)
    expect(invocation.options.stdio).toEqual(['pipe', 'ignore', 'ignore'])
  }, 7000)

  it('survives launcher exit and SIGHUP while serving independent client processes', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'store-nova-broker-lifecycle-'))
    roots.push(root)
    const socketPath = resolve(root, 'private', 'broker.sock')
    const account = 'd'.repeat(64)
    const secret = 'lifecycle-secret-never-logged'
    const executable = fileURLToPath(new URL('./keychain-broker.mjs', import.meta.url))
    const broker = spawn(process.execPath, [executable, '--serve-seeded'], {
      detached: true, env: { STORENOVA_QA_BROKER_SOCKET: socketPath }, stdio: ['pipe', 'ignore', 'pipe'],
    })
    if (!broker.stdin || !broker.stderr) throw new Error('broker lifecycle child lost stdio')
    let stderr = ''
    broker.stderr.on('data', chunk => { stderr += chunk.toString() })
    broker.stdin.end(JSON.stringify({ schema_version: '1', credentials: [{ account, data: secret }] }))
    try {
      const deadline = Date.now() + 5000
      let started = false
      while (Date.now() < deadline) {
        try { await requestKeychainBroker({ operation: 'ping' }, { socketPath, timeoutMs: 100 }); started = true; break }
        catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 10)) }
      }
      expect(started, `broker exit=${broker.exitCode} stderr=${stderr}`).toBe(true)
      await expect(requestKeychainBroker({ operation: 'read', service: 'com.storenova.merchant-mcp', account }, { socketPath }))
        .resolves.toBe(secret)
      process.kill(broker.pid!, 'SIGHUP')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      expect(broker.exitCode, `broker stderr=${stderr}`).toBeNull()

      const client = spawn(process.execPath, [executable, '--client'], {
        env: { STORENOVA_QA_BROKER_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (!client.stdin || !client.stdout || !client.stderr) throw new Error('broker client lost stdio')
      let clientOut = ''; let clientErr = ''
      client.stdout.on('data', chunk => { clientOut += chunk.toString() })
      client.stderr.on('data', chunk => { clientErr += chunk.toString() })
      client.stdin.end(JSON.stringify({ operation: 'read', service: 'com.storenova.merchant-mcp', account }))
      await new Promise<void>((resolvePromise, reject) => client.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`client exit=${code} stderr=${clientErr}`))))
      expect(clientOut).toBe(secret)
      expect(stderr).not.toContain(secret)
      expect(clientErr).not.toContain(secret)
    } finally {
      try { process.kill(-broker.pid!, 'SIGTERM') } catch {}
    }
  }, 10000)

  it('does not replace an unresponsive crash-stale socket until it is confirmed stale', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'store-nova-broker-stale-'))
    roots.push(root)
    const socketPath = resolve(root, 'private', 'broker.sock')
    const account = 'f'.repeat(64)
    const executable = fileURLToPath(new URL('./keychain-broker.mjs', import.meta.url))
    const broker = spawn(process.execPath, [executable, '--serve-seeded'], {
      detached: true, env: { STORENOVA_QA_BROKER_SOCKET: socketPath }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    if (!broker.stdin) throw new Error('broker stale-socket child lost stdin')
    broker.stdin.end(JSON.stringify({ schema_version: '1', credentials: [{ account, data: 'stale-session' }] }))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try { await requestKeychainBroker({ operation: 'ping' }, { socketPath, timeoutMs: 100 }); break }
      catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 10)) }
    }
    expect(existsSync(socketPath)).toBe(true)
    broker.kill('SIGKILL')
    await new Promise<void>(resolvePromise => broker.once('exit', () => resolvePromise()))
    let spawned = false
    await expect(startSeededKeychainBrokerDetached({ credentials: [{ account, data: 'replacement-session' }], socketPath,
      spawnProcess: (() => { spawned = true; throw new Error('must not replace an unresponsive socket') }) as any }))
      .rejects.toThrow('KEYCHAIN_BROKER_UNAVAILABLE')
    expect(spawned).toBe(false)
    expect(existsSync(socketPath)).toBe(true)
  }, 10000)

  it('cleans its socket on logout termination and replaces a crash-stale socket on the next login', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'store-nova-broker-relogin-'))
    roots.push(root)
    const socketPath = resolve(root, 'private', 'broker.sock')
    const account = 'e'.repeat(64)
    const executable = fileURLToPath(new URL('./keychain-broker.mjs', import.meta.url))
    const read = () => requestKeychainBroker({ operation: 'read', service: 'com.storenova.merchant-mcp', account }, { socketPath })
    const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (await predicate()) return
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      }
      throw new Error(`broker lifecycle timeout: ${label}`)
    }
    const launch = (data: string) => {
      const child = spawn(process.execPath, [executable, '--serve-seeded'], {
        env: { STORENOVA_QA_BROKER_SOCKET: socketPath }, stdio: ['pipe', 'ignore', 'pipe'],
      })
      if (!child.stdin || !child.stderr) throw new Error('broker relogin child lost stdio')
      child.stdin.end(JSON.stringify({ schema_version: '1', credentials: [{ account, data }] }))
      return child
    }

    const logoutBroker = launch('first-session')
    await waitFor(async () => { try { return await read() === 'first-session' } catch { return false } }, 'initial login')
    logoutBroker.kill('SIGTERM')
    await new Promise<void>(resolvePromise => logoutBroker.once('exit', () => resolvePromise()))
    await waitFor(() => !existsSync(socketPath), 'SIGTERM socket cleanup')

    const crashedBroker = launch('crashed-session')
    await waitFor(async () => { try { return await read() === 'crashed-session' } catch { return false } }, 'pre-crash login')
    crashedBroker.kill('SIGKILL')
    await new Promise<void>(resolvePromise => crashedBroker.once('exit', () => resolvePromise()))
    expect(existsSync(socketPath)).toBe(true)
    await expect(requestKeychainBroker({ operation: 'ping' }, { socketPath, timeoutMs: 100 })).rejects.toThrow()

    let staleSocketSpawned = false
    await expect(startSeededKeychainBrokerDetached({ credentials: [{ account, data: 'must-not-replace' }], socketPath,
      spawnProcess: (() => { staleSocketSpawned = true; throw new Error('must not replace an unresponsive socket') }) as any }))
      .rejects.toThrow('KEYCHAIN_BROKER_UNAVAILABLE')
    expect(staleSocketSpawned).toBe(false)
    expect(existsSync(socketPath)).toBe(true)

    // The harness knows the crashed test process exited, so it can safely
    // remove its stale pathname before exercising a clean login.
    unlinkSync(socketPath)
    let replacement: ReturnType<typeof spawn> | undefined
    await startSeededKeychainBrokerDetached({ credentials: [{ account, data: 'replacement-session' }], socketPath,
      spawnProcess: ((command: string, args: string[], options: any) => {
        replacement = spawn(command, args, { ...options, detached: false, stdio: ['pipe', 'ignore', 'pipe'] })
        return replacement
      }) as any })
    try {
      await expect(read()).resolves.toBe('replacement-session')
    } finally {
      replacement?.kill('SIGTERM')
      if (replacement) await new Promise<void>(resolvePromise => replacement!.once('exit', () => resolvePromise()))
    }
    await waitFor(() => !existsSync(socketPath), 'replacement socket cleanup')
  }, 20000)
  it('accepts only the exact operation schema and binding namespace', () => {
    expect(validateBrokerRequest({ operation: 'ping' })).toEqual({ operation: 'ping' })
    expect(validateBrokerRequest(request)).toEqual(request)
    expect(() => validateBrokerRequest({ ...request, operation: 'delete' })).toThrow('KEYCHAIN_BROKER_REQUEST_INVALID')
    expect(() => validateBrokerRequest({ ...request, service: 'other' })).toThrow('KEYCHAIN_BROKER_REQUEST_INVALID')
    expect(() => validateBrokerRequest({ ...request, extra: true })).toThrow('KEYCHAIN_BROKER_REQUEST_INVALID')
    expect(() => validateBrokerRequest({ ...request, operation: 'write' })).toThrow('KEYCHAIN_BROKER_REQUEST_INVALID')
  })

  it('serves a credential through a private socket without logging or changing the request', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'store-nova-broker-'))
    roots.push(root)
    const socketPath = resolve(root, 'private', 'broker.sock')
    const calls: unknown[] = []
    const server = createKeychainBroker({ socketPath, runHelper: (value: unknown) => {
      calls.push(value)
      return '{"access_token":"secret-only-in-response"}'
    } })
    await new Promise<void>((resolvePromise, reject) => server.listen(socketPath, () => resolvePromise()).once('error', reject))
    try {
      expect(lstatSync(resolve(root, 'private')).mode & 0o777).toBe(0o700)
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600)
      await expect(requestKeychainBroker({ operation: 'ping' }, { socketPath })).resolves.toBe('')
      await expect(requestKeychainBroker(request, { socketPath })).resolves.toBe('{"access_token":"secret-only-in-response"}')
      expect(calls).toEqual([request])
    } finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())) }
  })

  it('reuses a healthy seeded broker and rotates it without spawning a replacement', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'store-nova-broker-reuse-'))
    roots.push(root)
    const socketPath = resolve(root, 'private', 'broker.sock')
    const account = 'c'.repeat(64)
    const helper = createSeededMemoryHelper({ schema_version: '1', credentials: [{ account, data: 'old-secret' }] })
    const server = createKeychainBroker({ socketPath, runHelper: helper })
    await new Promise<void>((resolvePromise, reject) => server.listen(socketPath, () => resolvePromise()).once('error', reject))
    try {
      let spawned = false
      await startSeededKeychainBrokerDetached({ credentials: [{ account, data: 'new-secret' }], socketPath,
        spawnProcess: (() => { spawned = true; throw new Error('must not spawn') }) as any })
      expect(spawned).toBe(false)
      await expect(requestKeychainBroker({ operation: 'read', service: 'com.storenova.merchant-mcp', account }, { socketPath }))
        .resolves.toBe('new-secret')
    } finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())) }
  })

  it('rejects a socket writable by another user and fails closed on broker errors', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'store-nova-broker-'))
    roots.push(root)
    const socketPath = resolve(root, 'private', 'broker.sock')
    const server = createKeychainBroker({ socketPath, runHelper: () => { throw new Error('access_token=must-not-leak') } })
    await new Promise<void>((resolvePromise, reject) => server.listen(socketPath, () => resolvePromise()).once('error', reject))
    try {
      chmodSync(socketPath, 0o666)
      await expect(requestKeychainBroker(request, { socketPath })).rejects.toThrow('KEYCHAIN_BROKER_UNTRUSTED')
      chmodSync(socketPath, 0o600)
      await expect(requestKeychainBroker(request, { socketPath })).rejects.toThrow('KEYCHAIN_BROKER_RESPONSE_INVALID')
    } finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())) }
  })
})
