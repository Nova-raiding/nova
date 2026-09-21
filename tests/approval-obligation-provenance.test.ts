import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Guard for the `approval` authorization obligation.
 *
 * `satisfiedAuthorizationObligations` in `apps/api/src/server.ts` used to mark
 * `approval` satisfied from the caller-supplied `approved_by` / `approved_at`
 * request parameters:
 *
 *   if (typeof params.approved_by === 'string' && params.approved_by.trim()
 *     && typeof params.approved_at === 'string' && params.approved_at.trim()) satisfied.push('approval')
 *
 * Nothing proved that an approval act had happened, that the named approver
 * existed or was authorised for the target workspace, or that the approver was
 * not the requester. The value was then persisted into `ops_access_grants.approved_by`
 * and the audit event stream as if it were the record of an approval, so any
 * caller able to reach the method could forge maker-checker approval.
 *
 * The three methods whose policy requires `approval` are the JIT privilege-grant
 * issue path, the SLA correction decision and the commercial service-fulfilment
 * writes (`packages/contracts/src/authz.ts`), so this is the maker-checker
 * control on privilege escalation, not a cosmetic obligation.
 *
 * These assertions read the source rather than executing the handler, in the
 * source-scanning style of `tests/ops-component-architecture.test.ts`, because
 * the resolver is module-private and takes an `IncomingMessage` plus the
 * module-wide `requestPrincipals` map. Each assertion is written to fail on the
 * forged-approver shape rather than to snapshot today's exact text.
 */

const serverSource = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
const grantsMigration = readFileSync(new URL('../packages/persistence/src/migrations/105_durable_authorization_grants.sql', import.meta.url), 'utf8')

/**
 * Slice a top-level `function NAME(...) { ... }` (or `async function`) out of
 * `source`. Inside a top-level declaration the only line that is exactly `}` at
 * column 0 is the closing brace, so `\n}\n` terminates the body without a
 * brace-balancing parser that can be confused by braces in string literals.
 */
function topLevelFunction(source: string, name: string, label: string): string {
  const pattern = new RegExp(`\\n(?:async )?function ${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\(`, 'u')
  const match = pattern.exec(source)
  expect(match, `${label}: no top-level function ${name}`).not.toBeNull()
  if (!match) return ''
  const start = match.index
  const end = source.indexOf('\n}\n', start)
  expect(end, `${label}: ${name} does not close at column 0`).toBeGreaterThan(start)
  if (end < 0) return ''
  return source.slice(start, end)
}

/** The nearest top-level function enclosing `needle`; used so the assertion does not pin a helper name. */
function enclosingFunction(source: string, needle: string, label: string): string {
  const at = source.indexOf(needle)
  expect(at, `${label}: ${needle} is gone from the source`).toBeGreaterThanOrEqual(0)
  if (at < 0) return ''
  const start = source.lastIndexOf('\nfunction ', at)
  expect(start, `${label}: ${needle} is no longer inside a top-level function`).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''
  const end = source.indexOf('\n}\n', start)
  expect(end, `${label}: the function enclosing ${needle} does not close at column 0`).toBeGreaterThan(start)
  if (end < 0) return ''
  return source.slice(start, end)
}

/** Name of the helper that decides the `approval` obligation, read off its call site. */
function approvalResolver(): string {
  const obligations = topLevelFunction(serverSource, 'satisfiedAuthorizationObligations', 'approval provenance')
  const call = /if \(([A-Za-z_$][\w$]*)\(params, req, workspaceId\)\) satisfied\.push\('approval'\)/u.exec(obligations)
  expect(call, 'the approval obligation is not decided by a helper called with the request, the params and the workspace').not.toBeNull()
  if (!call) return ''
  return call[1] ?? ''
}

describe('approval obligation provenance', () => {
  it('does not mark approval satisfied from caller-supplied approver parameters', () => {
    const obligations = topLevelFunction(serverSource, 'satisfiedAuthorizationObligations', 'approval provenance')
    expect(obligations).toContain("satisfied.push('approval')")
    // The exact regression: the line that pushes `approval` must not itself be a
    // bare type-check on the two request parameters. Checking per line means a
    // reintroduced one-liner fails here rather than needing a new pattern.
    const approvalLines = obligations.split('\n').filter(line => line.includes("satisfied.push('approval')"))
    expect(approvalLines).toHaveLength(1)
    for (const line of approvalLines) {
      expect(line).not.toContain('approved_by')
      expect(line).not.toContain('approved_at')
    }
    // And nothing else in the resolver may read the unverified approver off the params.
    expect(obligations).not.toMatch(/params\.(?:approved_by|approved_at)/u)
  })

  it('resolves approval through server-side evidence instead of a request parameter', () => {
    const name = approvalResolver()
    expect(name).not.toBe('')
    const resolver = topLevelFunction(serverSource, name, 'approval provenance')
    // The trust anchor has to be a credential the caller cannot mint (a header
    // the server resolves against its own token registry) plus server config.
    expect(resolver).toContain("header(req, 'x-authorization-approval-token')")
    expect(resolver).toContain('AUTHORIZATION_APPROVAL_TOKENS')
    // And the helper wired into `satisfied.push('approval')` must be the very
    // function that consults that server config, not an unrelated helper.
    expect(resolver).toBe(enclosingFunction(serverSource, 'AUTHORIZATION_APPROVAL_TOKENS', 'approval provenance'))
    // No evidence means no approval: fail closed instead of falling back to params.
    expect(resolver).toContain('if (!token) return undefined')
    // The workspace the operation targets must reach the resolver, or the token
    // cannot be bound to the tenant it approves.
    const calls = serverSource.match(/satisfiedAuthorizationObligations\(params, req, workspaceId\)/gu) ?? []
    expect(calls).toHaveLength(1)
  })

  it('rejects self-approval and an approver claim the token does not establish', () => {
    const resolver = topLevelFunction(serverSource, approvalResolver(), 'approval provenance')
    // Separation of duties: the verified approver may not be the requester.
    expect(resolver).toMatch(/grantActor === actorId\)\s*return undefined/u)
    // A claimed `approved_by` may only confirm the token's identity, never establish it.
    expect(resolver).toMatch(/claimedBy !== grantActor\)\s*return undefined/u)
    // The token is bound to the workspace the grant request targets, so a token
    // issued for one tenant cannot approve another tenant's request.
    expect(resolver).toContain('grantWorkspaces.includes(target)')
    // A malformed token registry fails closed (throws) rather than silently
    // degrading into "no verification needed".
    expect(resolver).toContain('AUTHORIZATION_APPROVAL_CONFIG_INVALID')
    // `approved_at` is a caller-supplied string, not evidence of an approval act.
    expect(resolver).not.toContain('approved_at')
  })

  it('refuses the operation when approval is missing, even under a shadow-only policy', () => {
    const enforce = topLevelFunction(serverSource, 'enforceRegisteredMcpCapability', 'approval enforcement')
    expect(enforce).toContain("decision.obligations.missing.includes('approval')")
    // `evaluateAuthorizationDecision` returns `allowed: true` (shadow_allow) for a
    // missing obligation in shadow mode. Without this hard reject the caller's
    // fabricated approver would still be persisted while the policy "observes".
    expect(enforce).toContain("if (!decision.allowed || decision.obligations.missing.includes('approval')) throw new DomainError(ERROR_CODES.FORBIDDEN")
    // The browser has to be allowed to present the evidence the resolver reads.
    expect(serverSource).toMatch(/access-control-allow-headers.*x-authorization-approval-token/u)
  })

  it('keeps the database backstop a string floor, never the separation control', () => {
    // `ops_access_grants.approved_by` is free text (no identity reference), and
    // the only separation constraint is string inequality guarded on write
    // grants: `CHECK (access_mode <> 'write' OR approved_by <> issued_by)`. It
    // proves nothing about an approval act — it refuses only the literal case
    // approver == issuer, and only for write grants. Read grants have no
    // separation CHECK at all. The database therefore cannot be the control;
    // the application must carry the real provenance requirement asserted above.
    expect(grantsMigration).toContain("CHECK (access_mode <> 'write' OR approved_by <> issued_by)")
    expect(grantsMigration).toContain('approved_by TEXT NOT NULL')
    const inequalityChecks = grantsMigration.match(/approved_by <> issued_by/gu) ?? []
    expect(inequalityChecks).toHaveLength(1)
    // No unconditional separation CHECK: it is always guarded by access_mode.
    expect(grantsMigration).not.toMatch(/CHECK \(approved_by <> issued_by\)/u)
    // And nothing separates approver from issuer for read grants.
    expect(grantsMigration).not.toMatch(/access_mode <> 'read' OR approved_by/u)
    // The approver is not an identity reference, unlike the grant subject, so
    // the database cannot even assert that the approver exists.
    expect(grantsMigration).not.toMatch(/approved_by\s+UUID/u)
    expect(grantsMigration).toContain('subject_identity_id UUID NOT NULL REFERENCES platform_identities(id)')
  })
})
