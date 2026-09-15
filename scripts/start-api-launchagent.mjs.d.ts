export declare const MODEL_ENV_NAMES: readonly string[]
export declare function parseEnvFile(text: string): Map<string, string>
export declare function applyModelEnvironment(
  target: Record<string, string | undefined>,
  envText: string,
): Record<string, string | undefined>
export declare function readRelayKey(target?: NodeJS.ProcessEnv): string
export declare function startApi(): Promise<void>
