import { createFileRoute, Navigate } from '@tanstack/react-router';
import { HowItWorks } from '@/components/how-it-works';
import { useOrgContext } from '@/hooks/use-org-context';

export const Route = createFileRoute('/')({ component: HomePage });

function HomePage() {
  const { isAuthenticated, authReady, currentOwner } = useOrgContext();

  if (authReady && isAuthenticated && currentOwner) {
    return (
      <Navigate
        to="/$owner"
        params={{ owner: currentOwner }}
        search={{ editEntityTypes: undefined }}
      />
    );
  }

  return <HowItWorks isAuthenticated={isAuthenticated} />;
}
