import { magicLinkClient, organizationClient, phoneNumberClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Auth client connects to existing Better Auth backend
export const authClient = createAuthClient({
  baseURL:
    import.meta.env.VITE_API_URL ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787'),
  plugins: [organizationClient(), magicLinkClient(), phoneNumberClient()],
});

// Export commonly used methods
export const {
  signIn,
  signOut,
  signUp,
  useSession,
  organization,
  useActiveOrganization,
  useListOrganizations,
  phoneNumber,
} = authClient;

// Type exports
export type Session = typeof authClient.$Infer.Session;
export type User = Session['user'];
export type Organization = typeof authClient.$Infer.Organization;
