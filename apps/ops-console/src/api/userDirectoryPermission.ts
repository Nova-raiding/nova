import type { AuthorizationProjection } from "../authz/authorization.js";

/** Keep the user export UI and RPC preflight on the MCP contract capability. */
export function canExportUserDirectory(authorization: Pick<AuthorizationProjection, "can">): boolean {
  return authorization.can("billing.export");
}
