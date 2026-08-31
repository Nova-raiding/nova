import { createContext, useContext, type ReactNode } from "react";
import type { AuthorizationProjection } from "./authorization.js";

const AuthorizationContext = createContext<AuthorizationProjection | undefined>(undefined);

export function AuthorizationProvider({
  authorization,
  children,
}: {
  authorization: AuthorizationProjection;
  children: ReactNode;
}) {
  return (
    <AuthorizationContext.Provider value={authorization}>
      {children}
    </AuthorizationContext.Provider>
  );
}

export function useAuthorization(): AuthorizationProjection {
  const authorization = useContext(AuthorizationContext);
  if (!authorization) throw new Error("useAuthorization must be used inside AuthorizationProvider");
  return authorization;
}
