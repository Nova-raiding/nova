export interface GatewayIdentity {
  id: string;
  project: string;
  service: string;
  requiredNetwork?: string;
}
export interface GatewaySnapshot {
  schema_version: number;
  container_id: string;
  image_id: string;
  mounts: Array<{ source: string; destination: string; content_sha256: string }>;
  running: boolean;
  [key: string]: unknown;
}
export function digestPath(path: string): string;
export function protectedPath(path: string, options?: { file?: boolean; privateFile?: boolean }): void;
export function main(argv?: string[]): void;
export function createHandoffCore(dependencies: {
  inspect: (id: string) => unknown;
  stop: (id: string) => unknown;
  start: (id: string) => unknown;
  lockProbe: () => boolean;
  otherRunningPortCheck: (excludeId: string) => boolean;
}): {
  snapshot(input: GatewayIdentity): GatewaySnapshot;
  stopAndRestore(input: GatewayIdentity & { saved: GatewaySnapshot; restore?: boolean }): void;
};
