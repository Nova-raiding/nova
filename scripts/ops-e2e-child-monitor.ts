import type { ChildProcess } from 'node:child_process'

/**
 * Latches unexpected lifetime failures from a long-running E2E service.
 * Stopping the monitor only detaches its observers; process ownership remains
 * with the runner that spawned the child.
 */
export function monitorOpsE2eChild(child: ChildProcess) {
  let stopped = false
  let fault: Error | undefined
  let rejectFailure!: (error: Error) => void
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject })
  // The child may fail between guarded phases. Keep the latched rejection
  // observed even when no phase is currently racing it.
  void failure.catch(() => undefined)

  const latchFailure = () => {
    if (stopped || fault) return
    fault = new Error('OPS_E2E_SERVICE_RUNTIME_FAILED')
    rejectFailure(fault)
  }
  const onError = () => latchFailure()
  const onExit = () => latchFailure()

  child.on('error', onError)
  child.on('exit', onExit)

  // spawn() exposes pid synchronously on success. These checks also cover a
  // service that failed before the monitor could register its listeners.
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) latchFailure()

  return {
    guard<T>(operation: Promise<T>): Promise<T> {
      if (fault) {
        // The operation already exists when guard is called. Observe a later
        // rejection even though the latched service fault takes precedence.
        void operation.catch(() => undefined)
        return Promise.reject(fault)
      }
      if (stopped) return operation
      return Promise.race([operation, failure])
    },
    assertHealthy() {
      if (fault) throw fault
    },
    stop() {
      if (stopped) return
      stopped = true
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    },
  }
}

/** Terminates one runner-owned service without exposing native process errors. */
export async function disposeOpsE2eChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }
    const complete = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('OPS_E2E_CHILD_CLEANUP_FAILED'))
    }
    const onError = () => fail()
    const onExit = () => complete()
    const send = (signal: NodeJS.Signals) => {
      if (settled) return
      try {
        if (!child.kill(signal)) { fail(); return }
      } catch {
        fail()
        return
      }
      if (settled) return
      timer = setTimeout(() => {
        timer = undefined
        if (signal === 'SIGTERM') send('SIGKILL')
        else fail()
      }, 5_000)
    }

    // Install both observers before the first signal is delivered. kill() may
    // synchronously emit either event in test doubles and platform adapters.
    child.on('error', onError)
    child.on('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) complete()
    else send('SIGTERM')
  })
}
