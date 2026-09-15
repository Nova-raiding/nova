import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOpsE2eChild, monitorOpsE2eChild } from '../scripts/ops-e2e-child-monitor.js'

class FakeChild extends EventEmitter {
  pid: number | undefined = 1234
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn()
}

function child(overrides: Partial<Pick<FakeChild, 'pid' | 'exitCode' | 'signalCode'>> = {}) {
  return Object.assign(new FakeChild(), overrides) as unknown as ChildProcess
}

afterEach(() => vi.useRealTimers())

describe('Ops E2E child lifetime monitor', () => {
  it.each([
    ['zero exit', 0, null],
    ['non-zero exit', 7, null],
    ['signal exit', null, 'SIGTERM'],
  ] as const)('rejects a guarded phase on unexpected %s', async (_label, code, signal) => {
    const service = child()
    const monitor = monitorOpsE2eChild(service)
    const guarded = monitor.guard(new Promise<never>(() => {}))
    service.emit('exit', code, signal)
    await expect(guarded).rejects.toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
    expect(() => monitor.assertHealthy()).toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
    monitor.stop()
  })

  it('hides a raw spawn error behind the fixed runtime failure', async () => {
    const service = child()
    const monitor = monitorOpsE2eChild(service)
    const guarded = monitor.guard(new Promise<never>(() => {}))
    service.emit('error', new Error('spawn failed with private path'))
    await expect(guarded).rejects.toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
    expect(() => monitor.assertHealthy()).not.toThrow('private path')
    monitor.stop()
  })

  it.each([
    ['already exited', { exitCode: 0 }],
    ['already signalled', { signalCode: 'SIGKILL' as NodeJS.Signals }],
    ['never started', { pid: undefined }],
  ])('fails closed when registered after a %s child', async (_label, state) => {
    const monitor = monitorOpsE2eChild(child(state))
    expect(() => monitor.assertHealthy()).toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
    await expect(monitor.guard(Promise.resolve('too late'))).rejects.toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
    monitor.stop()
  })

  it('returns a guarded result while the service remains running', async () => {
    const monitor = monitorOpsE2eChild(child())
    await expect(monitor.guard(Promise.resolve('complete'))).resolves.toBe('complete')
    expect(() => monitor.assertHealthy()).not.toThrow()
    monitor.stop()
  })

  it('stop removes only this monitor listeners and never kills the child', () => {
    const service = child() as unknown as FakeChild
    const externalExit = vi.fn()
    const externalError = vi.fn()
    service.on('exit', externalExit)
    service.on('error', externalError)
    const beforeExit = service.listenerCount('exit')
    const beforeError = service.listenerCount('error')
    const monitor = monitorOpsE2eChild(service as unknown as ChildProcess)
    expect(service.listenerCount('exit')).toBe(beforeExit + 1)
    expect(service.listenerCount('error')).toBe(beforeError + 1)

    monitor.stop()

    expect(service.listenerCount('exit')).toBe(beforeExit)
    expect(service.listenerCount('error')).toBe(beforeError)
    expect(service.kill).not.toHaveBeenCalled()
    service.emit('exit', 0, null)
    service.emit('error', new Error('external observer owns this'))
    expect(externalExit).toHaveBeenCalledOnce()
    expect(externalError).toHaveBeenCalledOnce()
    expect(() => monitor.assertHealthy()).not.toThrow()
  })

  it('stop does not clear a failure that was already latched', async () => {
    const service = child()
    const monitor = monitorOpsE2eChild(service)
    service.emit('exit', 0, null)
    monitor.stop()
    expect(() => monitor.assertHealthy()).toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
    await expect(monitor.guard(Promise.resolve('must not pass'))).rejects.toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
  })

  it('observes the phase rejection when a previously latched fault takes precedence', async () => {
    const service = child()
    const monitor = monitorOpsE2eChild(service)
    service.emit('exit', 0, null)
    const phase = Promise.reject(new Error('later phase rejection'))
    await expect(monitor.guard(phase)).rejects.toThrow('OPS_E2E_SERVICE_RUNTIME_FAILED')
    monitor.stop()
  })
})

describe('Ops E2E child cleanup', () => {
  it('installs error handling before SIGTERM can synchronously fail', async () => {
    const service = child() as unknown as FakeChild
    service.kill.mockImplementation(() => {
      service.emit('error', new Error('native signal detail'))
      return false
    })
    await expect(disposeOpsE2eChild(service as unknown as ChildProcess)).rejects.toThrow('OPS_E2E_CHILD_CLEANUP_FAILED')
    expect(service.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('normalizes a synchronous kill exception', async () => {
    const service = child() as unknown as FakeChild
    service.kill.mockImplementation(() => { throw new Error('private process path') })
    await expect(disposeOpsE2eChild(service as unknown as ChildProcess)).rejects.toThrow('OPS_E2E_CHILD_CLEANUP_FAILED')
  })

  it('completes after a normal TERM exit', async () => {
    const service = child() as unknown as FakeChild
    service.kill.mockImplementation(signal => {
      service.signalCode = signal as NodeJS.Signals
      service.emit('exit', null, signal)
      return true
    })
    await expect(disposeOpsE2eChild(service as unknown as ChildProcess)).resolves.toBeUndefined()
    expect(service.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('escalates once to SIGKILL after five seconds', async () => {
    vi.useFakeTimers()
    const service = child() as unknown as FakeChild
    service.kill.mockImplementation(signal => {
      if (signal === 'SIGKILL') service.emit('exit', null, signal)
      return true
    })
    const cleanup = disposeOpsE2eChild(service as unknown as ChildProcess)
    expect(service.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(cleanup).resolves.toBeUndefined()
    expect(service.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails within ten seconds when the child never exits', async () => {
    vi.useFakeTimers()
    const service = child() as unknown as FakeChild
    service.kill.mockReturnValue(true)
    const cleanup = disposeOpsE2eChild(service as unknown as ChildProcess)
    const observed = expect(cleanup).rejects.toThrow('OPS_E2E_CHILD_CLEANUP_FAILED')
    await vi.advanceTimersByTimeAsync(10_000)
    await observed
    expect(service.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes only its own cleanup listeners', async () => {
    const service = child() as unknown as FakeChild
    const externalExit = vi.fn()
    const externalError = vi.fn()
    service.on('exit', externalExit)
    service.on('error', externalError)
    const exitListeners = service.listenerCount('exit')
    const errorListeners = service.listenerCount('error')
    service.kill.mockImplementation(signal => { service.emit('exit', null, signal); return true })
    await disposeOpsE2eChild(service as unknown as ChildProcess)
    expect(service.listenerCount('exit')).toBe(exitListeners)
    expect(service.listenerCount('error')).toBe(errorListeners)
    expect(externalExit).toHaveBeenCalledOnce()
    expect(externalError).not.toHaveBeenCalled()
  })

  it.each([
    ['no pid', { pid: undefined }],
    ['already exited', { exitCode: 0 }],
    ['already signalled', { signalCode: 'SIGTERM' as NodeJS.Signals }],
  ])('returns without signaling a child with %s', async (_label, state) => {
    const service = child(state) as unknown as FakeChild
    await expect(disposeOpsE2eChild(service as unknown as ChildProcess)).resolves.toBeUndefined()
    expect(service.kill).not.toHaveBeenCalled()
  })
})
