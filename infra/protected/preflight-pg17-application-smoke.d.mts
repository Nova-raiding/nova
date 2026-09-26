export function parseSmokeEnv(source: string): Record<string, string>
export function validateSmokeImageInventory(images: Record<string, any>, capture: Record<string, any>): void
export function validateWorkerRestoreSmokeResult(result: Record<string, any>, capture: Record<string, any>, workspaceId: string): void
export function ownsWorkerProbeContainer(container: Record<string, any>, ownership: { containerName: string; nonce: string; imageId: string; network: Record<string, any> }): boolean
export function cleanupWorkerProbeContainer(containerName: string, ownership: { nonce: string; imageId: string; network: Record<string, any> }, runner?: (...args: any[]) => any): void
export function runWorkerProbe(input: { workerEnvPath: string; images: Record<string, any>; network: Record<string, any>; capture: Record<string, any>; workspaceId: string; runner?: (...args: any[]) => any }): { observation: Record<string, any>; containerName: string }
export function validatePostProbeTopology(input: Parameters<typeof validatePg17SmokeTopology>[0], after: { network: Record<string, any>; postgres: Record<string, any>; redis: Record<string, any> }, workerGone: boolean): string[]
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
