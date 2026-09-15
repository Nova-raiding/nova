import type { OpsSession } from "../types/ops.js";

/** Display-only: authentication and authorization must continue using actor_id. */
export function accountLabel(session?: Pick<OpsSession, "account_login"> | null): string {
  if (!session) return "未登录";
  const login = session.account_login;
  return typeof login === "string" && login.trim() ? login.trim() : "账号名称未提供";
}
