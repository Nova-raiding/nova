export const MODEL_ENV_NAMES: readonly string[]

export function parseEnvFile(text: string): Map<string, string>

export function applyModelEnvironment<T extends Record<string, string | undefined>>(target: T, envText: string): T

export function readRelayKey(target?: Record<string, string | undefined>): string

export function startApi(): Promise<void>
