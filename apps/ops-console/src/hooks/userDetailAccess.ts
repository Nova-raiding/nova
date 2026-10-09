import type { AuthorizationProjection } from "../authz/authorization.js";

/** User details are a read surface; mutating identity state uses identity.update. */
export function canReadOpsUserDetail(authorization: Pick<AuthorizationProjection, "can">): boolean {
  return authorization.can("identity.read");
}
