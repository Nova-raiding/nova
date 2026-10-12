export const TEMPORARY_CREDENTIAL_ERROR_CODE = 'MCP_CREDENTIAL_SOURCE_TEMPORARILY_UNAVAILABLE'

export function createManagedCredentialLoader({ load, clear }) {
  let permanentlyUnavailable = false
  let inFlight
  let settled = false

  return {
    async ensure({ forceReload = false } = {}) {
      if (permanentlyUnavailable) return false
      // A refresh rereads the shared store after taking its cross-process lock.
      // Invalidate only a settled cache; concurrent callers still share a read.
      if (forceReload && settled) inFlight = undefined
      if (!inFlight) {
        settled = false
        inFlight = Promise.resolve().then(load).then(() => {
          settled = true
          return true
        }, error => {
          settled = true
          clear()
          if (error?.code === TEMPORARY_CREDENTIAL_ERROR_CODE) {
            // A broker may be starting or restarting. Fail this call closed, but
            // let the next business call perform a fresh managed-store read.
            inFlight = undefined
            return false
          }
          permanentlyUnavailable = true
          return false
        })
      }
      return inFlight
    },
    isPermanentlyUnavailable() { return permanentlyUnavailable },
  }
}
