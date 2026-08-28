export interface PlatformWriteBoundaryInput {
  production: boolean
  fixtureMode: boolean
  connectorConfigured: boolean
  pluginWriteEnabled: boolean
  canaryReady: boolean
}

/**
 * Decide whether a platform write may be attempted. Fixture writes are useful
 * for local development but are never a production capability, regardless of
 * stale environment flags.
 */
export function platformWriteAllowed(input: PlatformWriteBoundaryInput): boolean {
  if (!input.connectorConfigured) return false
  if (input.production && input.fixtureMode) return false
  if (input.fixtureMode) return input.pluginWriteEnabled
  return !input.production || input.canaryReady
}
