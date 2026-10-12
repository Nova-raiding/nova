export interface LaunchdEnvironmentOptions {
  environment?: Record<string, string | undefined>
  platform?: string
  execFileSync?: (
    file: string,
    args: string[],
    options: {
      encoding: 'utf8'
      stdio: ['ignore', 'pipe', 'ignore']
      timeout: number
    },
  ) => string
}

export const LAUNCHD_ENVIRONMENT_NAMES: readonly string[]

export function launchctlExecutable(platform?: string): string

export function restoreLaunchdEnvironment(options?: LaunchdEnvironmentOptions): string[]
