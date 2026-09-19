import type { OpsSession } from "../types/ops.js";

/** One server-projected temporary (JIT) grant from the session projection. */
export type OpsTemporaryGrant = NonNullable<OpsSession["temporary_grants"]>[number];

/** Shared by the controlled-session warning bar and the role/scope summary so
 * both render the same countdown and pick the same "active" grant. */
export function formatJitRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60).toString().padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

export function activeJitGrantForNow<T extends { expires_at?: string }>(
  grants: readonly T[] | undefined,
  now: number,
) {
  return grants?.find((grant) => !grant.expires_at || Date.parse(grant.expires_at) > now);
}

/** Earliest finite expiry across the server-projected grants: the moment the
 * client must stop relying on the projection it is currently holding. Grants
 * without an expiry are bounded by the session itself and have no deadline. */
export function nextJitExpiryAt(
  grants: readonly { expires_at?: string }[] | undefined,
): number | undefined {
  const deadlines = (grants ?? [])
    .map((grant) => (grant.expires_at ? Date.parse(grant.expires_at) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

export function jitScopeLabel(grant: OpsTemporaryGrant): string {
  const scope = grant.resource_scope;
  return `${scope?.type ?? "workspace"}:${scope?.ids?.join(", ") ?? grant.workspace_id ?? "未返回"}`;
}

export function jitUseBudgetLabel(grant: OpsTemporaryGrant): string | undefined {
  return grant.max_uses === undefined
    ? undefined
    : `已使用 ${grant.use_count ?? 0}/${grant.max_uses} 次`;
}
