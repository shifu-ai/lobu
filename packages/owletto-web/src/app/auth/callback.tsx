import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthState } from '@/lib/auth-state';

export const Route = createFileRoute('/auth/callback')({
  component: CallbackPage,
});

function CallbackPage() {
  const navigate = useNavigate();
  const { isReady } = useAuthState();

  useEffect(() => {
    if (isReady) {
      // Give session time to be set then redirect
      setTimeout(() => {
        navigate({ to: '/' });
      }, 500);
    }
  }, [isReady, navigate]);

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center">
      <div className="text-center">
        <p className="text-muted-foreground">
          {!isReady ? 'Completing sign in...' : 'Redirecting...'}
        </p>
      </div>
    </div>
  );
}
