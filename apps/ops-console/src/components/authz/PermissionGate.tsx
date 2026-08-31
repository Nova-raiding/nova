import { Alert } from "antd";
import type { ReactNode } from "react";
import { useAuthorization } from "../../authz/AuthorizationProvider.js";

export function PermissionGate({
  capability,
  anyOf,
  behavior = "hide",
  children,
  fallback,
}: {
  capability?: string;
  anyOf?: readonly string[];
  behavior?: "hide" | "readonly";
  children: ReactNode | ((state: { allowed: boolean; readOnly: boolean }) => ReactNode);
  fallback?: ReactNode;
}) {
  const authorization = useAuthorization();
  const required = anyOf ?? (capability ? [capability] : []);
  const allowed = required.length > 0 && authorization.canAny(required);
  if (typeof children === "function") return <>{children({ allowed, readOnly: !allowed })}</>;
  if (allowed) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (behavior === "readonly") {
    return <Alert type="info" showIcon title="当前范围为只读" description={`缺少能力：${required.join(" 或 ")}`} />;
  }
  return null;
}
