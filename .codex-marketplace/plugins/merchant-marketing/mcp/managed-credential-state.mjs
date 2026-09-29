export const TEMPORARY_CREDENTIAL_ERROR_CODE = 'MCP_CREDENTIAL_SOURCE_TEMPORARILY_UNAVAILABLE'

export function createManagedCredentialLoader({ load, clear }) {
  let permanentlyUnavailable = false
  let inFlight

  return {
    async ensure() {
      if (permanentlyUnavailable) return false
      if (!inFlight) {
        inFlight = Promise.resolve().then(load).then(() => true, error => {
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
