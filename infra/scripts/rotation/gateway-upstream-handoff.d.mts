export function sha256(value: string): string

export function rewriteApiUpstream(
  config: string,
  from: string,
  to: string,
): { config: string; before_sha256: string; after_sha256: string }
