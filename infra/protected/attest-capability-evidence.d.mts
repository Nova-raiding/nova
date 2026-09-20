/**
 * The read methods each platform family may be dispatched with, and the
 * predicate the repo-side gate reads instead of restating the family rule.
 */
export const PLATFORM_READ_METHODS: Readonly<Record<string, readonly string[]>>
export function readMethodAllowed(platform: string, method: string): boolean
export function validateCandidate(value: unknown, binding: { releaseId: string }, root: string, now?: Date): unknown
export function signCandidate(value: unknown, binding: { releaseId: string; imageSetDigest: string; manifestSha256: string; releaseGitSha: string; deploymentNonce: string; keyId: string }, root: string, privatePem: string | Buffer, publicPem: string | Buffer): Record<string, unknown>
