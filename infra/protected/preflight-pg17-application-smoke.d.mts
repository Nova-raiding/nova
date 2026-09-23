export function parseSmokeEnv(source: string): Record<string, string>
export function validatePg17SmokeTopology(input: {
  capture: Record<string, any>
  network: Record<string, any>
  postgres: Record<string, any>
  redis: Record<string, any>
  images: Record<string, any>
  apiEnv: Record<string, string>
  workerEnv: Record<string, string>
  roles: Array<Record<string, any>>
}): string[]
