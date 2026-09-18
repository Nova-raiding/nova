export const EVIDENCE_KINDS: readonly string[]
export function createBundle(paths: Record<string,string>, binding: {releaseId:string;imageSetDigest:string;manifestSha256:string;releaseGitSha:string;deploymentNonce:string;keyId:string}, root:string, privatePem:string|Buffer, publicPem:string|Buffer, now?:Date): Record<string,unknown>
