export interface OpsSidecarReviewInput {
  compose: unknown;
  manifest: unknown;
  identity: unknown;
  images: unknown;
  attestation: unknown;
  containers: unknown;
  network: unknown;
  imageInspects: unknown;
  sidecarProject: string;
}

export function validateOpsSidecarInputs(input: OpsSidecarReviewInput): {
  baseProject: string;
  networkName: string;
};

export function candidateOpsReviewTlsConfig(): string;

export interface OpsReviewStat {
  uid: number;
  gid: number;
  mode: number;
}

export function assertOpsReviewCertificateAccess(input: {
  directory: OpsReviewStat & { isDirectory(): boolean };
  privateKey: OpsReviewStat & { isFile(): boolean };
  fullchain: OpsReviewStat & { isFile(): boolean };
}): void;

export function writeReviewOutputFile(path: string, contents: string | Uint8Array, mode?: number): void;

export function createOpsSidecarCompose(input: {
  networkName: string;
  sidecarProject: string;
  images: unknown;
  identity: unknown;
  certDir: string;
  configPath: string;
}): any;

export function render(argv?: string[]): {
  status: 'rendered_only';
  project: string;
  base_project: string;
  release_id: string;
  git_sha: string;
  network: string;
  loopback_tls_port: 18445;
  compose: string;
  nginx: string;
};
