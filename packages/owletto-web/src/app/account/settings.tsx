import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';

export const Route = createFileRoute('/account/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const { session, isReady } = useAuthState();

  if (!isReady) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="max-w-md mx-auto text-center space-y-4">
          <h1 className="text-2xl font-semibold">Not signed in</h1>
          <p className="text-muted-foreground">Please sign in to view your settings.</p>
          <Link
            to="/auth/$pathname"
            params={{ pathname: 'sign-in' }}
            search={{
              callbackUrl: undefined,
              mode: undefined,
              error: undefined,
              errorDescription: undefined,
              loginHint: undefined,
              invitationOrg: undefined,
            }}
            className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            Sign In
          </Link>
        </div>
      </div>
    );
  }

  const handleSignOut = async () => {
    await signOut();
    window.location.href = '/';
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-muted-foreground">Manage your account settings</p>
        </div>

        {/* Profile Section */}
        <div className="rounded-lg border border-border bg-card p-6 space-y-6">
          <h2 className="text-lg font-medium">Profile</h2>

          <div className="flex items-center gap-4">
            {session.user.image ? (
              <img
                src={session.user.image}
                alt={session.user.name || 'User'}
                referrerPolicy="no-referrer"
                className="h-16 w-16 rounded-full object-cover"
              />
            ) : (
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                <span className="text-xl font-medium text-primary">
                  {(session.user.name || session.user.email || 'U')[0].toUpperCase()}
                </span>
              </div>
            )}
            <div>
              <p className="font-medium">{session.user.name || 'User'}</p>
              <p className="text-sm text-muted-foreground">{session.user.email}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Name</p>
              <p className="mt-1">{session.user.name || 'Not set'}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Email</p>
              <p className="mt-1">{session.user.email}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">User ID</p>
              <p className="mt-1 text-xs font-mono text-muted-foreground">{session.user.id}</p>
            </div>
          </div>
        </div>

        {/* Sign Out Section */}
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <h2 className="text-lg font-medium">Account</h2>
          <p className="text-sm text-muted-foreground">Sign out of your account on this device.</p>
          <Button variant="destructive" onClick={handleSignOut}>
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}
