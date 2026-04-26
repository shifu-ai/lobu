import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { signOut } from '@/lib/auth';

export const Route = createFileRoute('/auth/logout')({
  component: LogoutPage,
});

function LogoutPage() {
  useEffect(() => {
    signOut()
      .catch((error) => console.error('Sign out failed:', error))
      .finally(() => {
        window.location.href = '/';
      });
  }, []);

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center">
      <p className="text-muted-foreground">Signing out...</p>
    </div>
  );
}
