declare module './start-api-launchagent.mjs' {
  export const MODEL_ENV_NAMES: readonly string[]
  export function parseEnvFile(text: string): Map<string, string>
  export function applyModelEnvironment(target: Record<string, string | undefined>, envText: string): Record<string, string | undefined>
  export function readRelayKey(target?: NodeJS.ProcessEnv): string
  export function startApi(): Promise<void>
}
