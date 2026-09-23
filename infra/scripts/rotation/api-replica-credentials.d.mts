export function envValue(env: string[], key: string): string
export function parseGrants(raw: string): Record<string, Record<string, unknown>>
export function rotateGrants(raw: string, random?: (size: number) => Buffer): {
  old: Record<string, Record<string, unknown>>
  rotated: Record<string, Record<string, unknown>>
  keyMap: Record<string, string>
  raw: string
}
export function snapshotReplica(inspect: any, expectedRaw: string): any
export function cloneSpec(snapshot: any, rotatedRaw: string): any
export function validateClone(snapshot: any, live: any, rotatedRaw: string, options?: { running?: boolean }): void
export function preflightEngineClone(engine: any, plan: ReturnType<typeof publicPlan>): Promise<void>
export function publicPlan(inspects: any[], raw: string, random?: (size: number) => Buffer): {
  report: {
    schema_version: number
    mode: string
    replica_count: number
    grant_count: number
    replicas: Array<{ name: string; id: string; image: string; fingerprint: string; networks: Array<{ name: string; id: string; alias_count: number }>; mount_count: number; healthcheck_present: boolean; restart_policy: string | null }>
  }
  snapshots: any[]
  specs: any[]
  rotation: ReturnType<typeof rotateGrants>
}
export function rotateReplicaPair(adapter: any, plan: ReturnType<typeof publicPlan>): Promise<{ status: string; old_containers_stopped: number; new_containers_healthy: number }>
export function greenSpec(snapshot: any, rotatedRaw: string, name: string): any
export function rotateWithGateway(args: { engine: any; gateway: any; source: any; plan: ReturnType<typeof publicPlan>; expectedGatewaySha256: string; publicReplicaName: string }): Promise<{ status: string; old_containers_stopped: number; new_containers_healthy: number; public_upstream: string }>
export function writeProtectedRotation(path: string, rotation: ReturnType<typeof rotateGrants>): void
export function executeAgainstEngine(args: { engine: any; ids: string[]; grantsFile: string; outputFile: string }): Promise<{ status: string; old_containers_stopped: number; new_containers_healthy: number }>
export function main(argv?: string[]): void | Promise<void>
