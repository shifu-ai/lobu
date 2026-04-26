import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import {
  useActiveOrganization as useBetterAuthActiveOrganization,
  useListOrganizations as useBetterAuthListOrganizations,
  useSession as useBetterAuthSession,
} from '@/lib/auth';

type SessionResult = ReturnType<typeof useBetterAuthSession>;
type ActiveOrganizationResult = ReturnType<typeof useBetterAuthActiveOrganization>;
type OrganizationListResult = ReturnType<typeof useBetterAuthListOrganizations>;

interface AuthStateContextValue {
  sessionResult: SessionResult;
  activeOrganizationResult: Pick<ActiveOrganizationResult, 'data' | 'isPending'>;
  organizationListResult: Pick<OrganizationListResult, 'data' | 'isPending'>;
  isAuthenticated: boolean;
  isReady: boolean;
}

const AuthStateContext = createContext<AuthStateContextValue | null>(null);

function AnonymousAuthStateProvider({
  children,
  sessionResult,
}: {
  children: ReactNode;
  sessionResult: SessionResult;
}) {
  return (
    <AuthStateContext.Provider
      value={{
        sessionResult,
        activeOrganizationResult: { data: null, isPending: false },
        organizationListResult: { data: null, isPending: false },
        isAuthenticated: false,
        isReady: true,
      }}
    >
      {children}
    </AuthStateContext.Provider>
  );
}

function AuthenticatedAuthStateProvider({
  children,
  sessionResult,
}: {
  children: ReactNode;
  sessionResult: SessionResult;
}) {
  const activeOrganizationResult = useBetterAuthActiveOrganization();
  const organizationListResult = useBetterAuthListOrganizations();

  return (
    <AuthStateContext.Provider
      value={{
        sessionResult,
        activeOrganizationResult: {
          data: activeOrganizationResult.data ?? null,
          isPending: activeOrganizationResult.isPending,
        },
        organizationListResult: {
          data: organizationListResult.data ?? null,
          isPending: organizationListResult.isPending,
        },
        isAuthenticated: true,
        isReady: !activeOrganizationResult.isPending && !organizationListResult.isPending,
      }}
    >
      {children}
    </AuthStateContext.Provider>
  );
}

export function AuthStateProvider({ children }: { children: ReactNode }) {
  const sessionResult = useBetterAuthSession();

  if (sessionResult.isPending) {
    return (
      <AuthStateContext.Provider
        value={{
          sessionResult,
          activeOrganizationResult: { data: null, isPending: true },
          organizationListResult: { data: null, isPending: true },
          isAuthenticated: false,
          isReady: false,
        }}
      >
        {children}
      </AuthStateContext.Provider>
    );
  }

  if (!sessionResult.data) {
    return (
      <AnonymousAuthStateProvider sessionResult={sessionResult}>
        {children}
      </AnonymousAuthStateProvider>
    );
  }

  return (
    <AuthenticatedAuthStateProvider sessionResult={sessionResult}>
      {children}
    </AuthenticatedAuthStateProvider>
  );
}

export function useAuthState() {
  const context = useContext(AuthStateContext);
  if (!context) {
    throw new Error('useAuthState must be used within AuthStateProvider');
  }

  return {
    session: context.sessionResult.data ?? null,
    sessionResult: context.sessionResult,
    activeOrganization: context.activeOrganizationResult.data ?? null,
    activeOrganizationResult: context.activeOrganizationResult,
    organizations:
      (context.organizationListResult.data as Array<{
        id: string;
        name: string;
        slug: string;
      }> | null) ?? [],
    organizationListResult: context.organizationListResult,
    isAuthenticated: context.isAuthenticated,
    isReady: context.isReady,
  };
}
