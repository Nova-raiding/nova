import type { CapabilityId } from "../../../../packages/contracts/src/authz.js";
import type { OpsDomain } from "../navigation/opsNavigation.js";
import type { OpsSession } from "../types/ops.js";

export type OpsCapability = string;
export type OpsScope = {
  kind: "platform" | "workspace" | "brand" | "store" | "controlled_support";
  id?: string;
  ids?: readonly string[];
};

export type AuthorizationProjection = {
  readonly managed: boolean;
  readonly roles: readonly string[];
  readonly capabilities: ReadonlySet<OpsCapability>;
  readonly deniedCapabilities: ReadonlySet<OpsCapability>;
  /** Server-projected resource scope for each capability; never inferred from roles. */
  readonly capabilityScopes: ReadonlyMap<OpsCapability, OpsScope>;
  readonly scope: OpsScope;
  readonly policyVersion?: string;
  readonly source: "server" | "local-development" | "deny-all";
  can(capability: OpsCapability): boolean;
  canAny(capabilities: readonly OpsCapability[]): boolean;
  scopeFor(capability: OpsCapability): OpsScope | undefined;
};

const platformRoles = new Set([
  "platform_owner", "platform_admin", "platform_ops", "platform_support", "platform_finance",
  "platform_commercial_admin", "platform_rules_admin", "platform_model_admin",
  "platform_security_auditor", "platform_release_admin", "ops_admin", "support_agent",
  "finance_ops", "security_admin", "auditor", "rules_admin", "model_admin", "release_admin",
]);

/** Canonical CapabilityId values shared with the server contracts. */
export const domainReadCapabilities: Readonly<Record<OpsDomain, readonly CapabilityId[]>> = {
  overview: ["platform.summary.read", "workspace.summary.read"],
  users: ["identity.read"],
  members: ["workspace.member.read", "workspace.member.manage"],
  support: ["support.ticket.read", "support.ticket.update"],
  incidents: ["incident.read", "incident.update", "incident.administer"],
  tasks: ["marketing.summary.read", "marketing.queue.read", "customer.content.read"],
  stores: ["platform.settings.read", "store.connection.read"],
  rules: ["rule.read", "platform.media_spec.read"],
  models: ["model.status.read", "model.cost.read", "model.policy.update"],
  "feature-flags": ["feature_flag.read", "feature_flag.update", "feature_flag.administer"],
  storage: ["storage.reconciliation.read", "workspace.summary.read"],
  finance: ["billing.self.read", "billing.workspace.read", "billing.platform.read", "commercial.read", "model.cost.read"],
  audit: ["audit.read", "audit.export"],
};

function serverPermissions(session: OpsSession) {
  const allow = new Set<string>();
  const deny = new Set<string>();
  const scopes = new Map<string, OpsScope>();
  for (const permission of session.effective_permissions ?? []) {
    const id = (typeof permission === "string" ? permission : permission.capability ?? permission.id ?? "").trim();
    if (!id) continue;
    if (typeof permission !== "string" && permission.effect === "deny") deny.add(id);
    else {
      allow.add(id);
      if (typeof permission !== "string" && permission.scope) {
        scopes.set(id, { kind: permission.scope.type, id: permission.scope.id ?? permission.scope.ids?.[0], ids: permission.scope.ids });
      }
    }
  }
  for (const capability of session.capabilities ?? []) {
    const id = capability.trim();
    if (id) allow.add(id);
  }
  return {
    allow,
    deny,
    present: session.effective_permissions !== undefined || session.capabilities !== undefined,
    scopes,
  };
}

function scopeMatchesWorkbench(scope: OpsScope | undefined, workbench: OpsSession["workbench"]): boolean {
  if (!workbench || !scope) return true;
  return workbench === "platform" ? scope.kind === "platform" : scope.kind !== "platform";
}

function inferScope(session: OpsSession | undefined): OpsScope {
  const explicit = session?.scope;
  if (explicit) return { kind: explicit.type, id: explicit.id ?? explicit.ids?.[0], ids: explicit.ids };
  const activeGrant = session?.temporary_grants?.find(
    (grant) => !grant.expires_at || Date.parse(grant.expires_at) > Date.now(),
  );
  if (activeGrant && session?.workspace_id) return { kind: "controlled_support", id: session.workspace_id };
  if (session?.workbench === "platform") {
    return { kind: "platform" };
  }
  const workspaceScope = session?.scopes?.find((candidate) => candidate.type === "workspace");
  if (session?.workbench === "workspace" || workspaceScope)
    return { kind: "workspace", id: workspaceScope?.ids[0] ?? session?.workspace_id ?? undefined, ids: workspaceScope?.ids };
  const effectiveRoles = session?.canonical_roles ?? session?.roles ?? [];
  if (effectiveRoles.some((role) => platformRoles.has(role))) return { kind: "platform" };
  return { kind: "workspace", id: session?.workspace_id || undefined };
}

export function createAuthorizationProjection(
  session: OpsSession | undefined,
  managed: boolean,
): AuthorizationProjection {
  const scope = inferScope(session);
  const projected = session
    ? serverPermissions(session)
    : { allow: new Set<string>(), deny: new Set<string>(), present: false, scopes: new Map<string, OpsScope>() };
  const sessionScope = session?.scope
    ? { kind: session.scope.type, id: session.scope.id ?? session.scope.ids?.[0], ids: session.scope.ids } satisfies OpsScope
    : session?.scopes?.find((candidate) => candidate.type === "platform")
      ? { kind: "platform" as const, id: session.scopes.find((candidate) => candidate.type === "platform")?.ids[0], ids: session.scopes.find((candidate) => candidate.type === "platform")?.ids }
      : session?.scopes?.find((candidate) => candidate.type === "workspace")
        ? { kind: "workspace" as const, id: session.scopes.find((candidate) => candidate.type === "workspace")?.ids[0], ids: session.scopes.find((candidate) => candidate.type === "workspace")?.ids }
        : undefined;
  const workbenchScopeValid = scopeMatchesWorkbench(sessionScope, session?.workbench);
  for (const capability of [...projected.allow]) {
    if (!workbenchScopeValid || !scopeMatchesWorkbench(projected.scopes.get(capability), session?.workbench)) {
      projected.allow.delete(capability);
      projected.scopes.delete(capability);
    }
  }
  // Credential transport (OIDC vs local Bearer) never changes authorization.
  // Both modes consume the server projection and remain deny-all before the
  // session arrives.
  const capabilities = projected.present ? projected.allow : new Set<string>();
  const can = (capability: string) => !projected.deny.has(capability) && capabilities.has(capability);
  return {
    managed,
    roles: session?.canonical_roles ?? session?.roles ?? [],
    capabilities,
    deniedCapabilities: projected.deny,
    capabilityScopes: projected.scopes,
    scope,
    policyVersion: session?.catalog_version ?? session?.policy_version,
    source: projected.present ? "server" : "deny-all",
    can,
    canAny: (required) => required.some(can),
    scopeFor: (capability) => can(capability) ? projected.scopes.get(capability) ?? scope : undefined,
  };
}

export function canViewDomain(authorization: AuthorizationProjection, domain: OpsDomain): boolean {
  return authorization.canAny(domainReadCapabilities[domain]);
}
