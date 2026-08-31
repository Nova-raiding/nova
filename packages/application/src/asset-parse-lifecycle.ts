export async function runWithAssetParseDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  assertPositiveInteger(timeoutMs, 'timeoutMs')
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(callerSignal?.reason)
  let timeout: ReturnType<typeof setTimeout> | undefined

  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', forwardAbort)
      controller.signal.removeEventListener('abort', onAbort)
    }
    const finish = (handler: (value: never) => void, value: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      handler(value as never)
    }
    const onAbort = () => finish(reject, controller.signal.reason ?? new DOMException('asset parse aborted', 'AbortError'))

    controller.signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => controller.abort(new DOMException('asset parse timed out', 'TimeoutError')), timeoutMs)
    if (callerSignal?.aborted) forwardAbort()
    else callerSignal?.addEventListener('abort', forwardAbort, { once: true })

    if (!controller.signal.aborted) {
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then(value => finish(resolve, value), error => finish(reject, error))
    }
  })
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive integer`)
}
