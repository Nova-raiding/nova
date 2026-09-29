# Platform and rule plugin audit — 2026-09-29

## Scope and identity

- Production endpoint: `https://yxsona.com/api/mcp`; merchant demo account `demo@ys.com`, workspace `ws_guirenniaoniao`. The account used a real password session to request a workspace-bound local-plugin MCP access token (`/api/v1/auth/mcp-token` returned HTTP 200). No token, password, cookie, or raw customer record is retained here.
- Production calls below used that token and the `workspace` workbench. They are API/MCP observations, not claims that each method was independently invoked in the ChatGPT UI.
- The installed ChatGPT plugin exposed **131** tools at the start of this audit. The then-installed platform/rule subset contained **16** tools. After local bridge changes from this QA round, the **local candidate** exposes **119** tools in total and 5 in this subset. The 119-tool candidate is not yet installed in ChatGPT or deployed to production.

## Production read-only calls on the installed 131-tool surface

| Method | HTTP | MCP error | Observed result and limit |
| --- | ---: | --- | --- |
| `platform.settings.get` | 403 | `FORBIDDEN` | Merchant lacks `platform.settings.read`; no settings returned. |
| `platform.media.spec.list` | 403 | `FORBIDDEN` | Merchant lacks `platform.media_spec.read`; no list returned. |
| `platform.media.spec.get` | 403 | `FORBIDDEN` | Same capability denial using a nonexistent QA ID; no record returned. |
| `rule.list` | 200 | none | Empty array (0 effective rules in this workspace). |
| `rule.sync.status` | 200 | none | Six platform rows (`jd`, `taobao`, `tmall`, `pinduoduo`, `xiaohongshu`, `douyin`); each `configured=false`, `stale=true`. |
| `rule.history` | 200 | none | Empty array for nonexistent QA pack ID; this verifies the empty path only. |
| `rule.audit` | 403 | `FORBIDDEN` | Merchant lacks platform `rule.read`; no audit data returned. |
| `ops.audit.list` | 403 | `FORBIDDEN` | Direct API permission probe; this method was already absent from merchant `tools/list`. |

An initial session-cookie-only MCP probe returned HTTP 401 `UNAUTHENTICATED` for the merchant plugin path. After minting the actual local-plugin MCP token, the results above reached the authorization and business handlers. This confirms the plugin-token requirement and avoids treating a login cookie as plugin authorization.

## Local candidate tool and gate checks

The candidate's merchant `tools/list` subset is exactly `platform.mapping.preflight`, `platform.store.alias.set`, `rule.list`, `rule.sync.status`, and `rule.history`. The three merchant-allowed rule reads remain listed.

The following 11 platform-workbench methods are absent from the local merchant `tools/list`, and direct `tools/call` attempts all returned JSON-RPC `-32602` (`Unknown tool`) without remote forwarding: `platform.settings.get`; `platform.media.spec.list`, `.get`, `.create`, `.update`, `.approve`, `.expire`; `rule.sync.now`, `.audit`, `.publish`, `.status`. Their platform scope is declared in `packages/contracts/src/authz.ts`.

With no interactive write confirmation, valid local calls to `platform.mapping.preflight` and `platform.store.alias.set` both returned `INTERACTIVE_WRITE_DISABLED`. `platform.mapping.preflight` is now annotated `readOnlyHint=false` and is excluded from read-only transport retries. The server implementation at `apps/api/src/server.ts` can upsert/revoke a mapping approval and persist a `platform.mapping.preflight_evaluated` event, so this method was **not** executed against production in this audit.

Targeted bridge and MCP surface contract tests after the local change: **112/112 passed** (`npx vitest run apps/plugin/mcp/bridge.test.ts tests/mcp-surface-contract.test.ts`). These tests do not replace a post-install ChatGPT UI invocation of the updated candidate.
