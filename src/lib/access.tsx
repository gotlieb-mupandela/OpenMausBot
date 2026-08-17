import { createContext, useContext } from "react";
import type { SaasUser } from "@/components/AuthScreen";

const AccessContext = createContext({ saas: false, plus: true });

export function AccessProvider({
  saas,
  user,
  children,
}: {
  saas: boolean;
  user: SaasUser | null;
  children: React.ReactNode;
}) {
  return (
    <AccessContext.Provider value={{ saas, plus: !saas || Boolean(user?.plus) }}>
      {children}
    </AccessContext.Provider>
  );
}

export function useAccess() {
  return useContext(AccessContext);
}
