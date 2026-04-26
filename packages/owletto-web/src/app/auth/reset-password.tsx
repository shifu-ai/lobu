import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { API_URL, fetchWithTimeout, getApiErrorMessage } from '@/lib/api/core';
import { pruneSearch } from '@/lib/router-search';

export const Route = createFileRoute('/auth/reset-password')({
  component: ResetPasswordPage,
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      token: typeof search.token === 'string' ? search.token : undefined,
      error: typeof search.error === 'string' ? search.error : undefined,
    }),
});

function ResetPasswordPage() {
  const { token, error: tokenError } = Route.useSearch();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDone, setIsDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError('This reset link is invalid or expired.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await fetchWithTimeout(`${API_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ token, newPassword }),
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response));
      }
      setIsDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setIsLoading(false);
    }
  };

  const invalidLink = !token || tokenError === 'INVALID_TOKEN';
  const loginSearch = {
    callbackUrl: undefined,
    mode: undefined,
    error: undefined,
    errorDescription: undefined,
    loginHint: undefined,
    invitationOrg: undefined,
    intent: undefined,
  } as const;

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center">
      <div className="w-full max-w-md p-8">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-2xl font-bold text-center">Reset your password</h1>

          {invalidLink && !isDone ? (
            <div className="mt-6 space-y-4 text-center">
              <p className="text-sm text-destructive">This reset link is invalid or expired.</p>
              <Link
                to="/auth/login"
                search={loginSearch}
                className="text-sm text-primary hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          ) : isDone ? (
            <div className="mt-6 space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                Your password has been reset successfully.
              </p>
              <Link
                to="/auth/login"
                search={loginSearch}
                className="text-sm text-primary hover:underline"
              >
                Continue to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              {error && (
                <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
                  {error}
                </div>
              )}
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium">
                  New password
                </label>
                <input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={8}
                  required
                  className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium">
                  Confirm new password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={8}
                  required
                  className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {isLoading ? 'Resetting password...' : 'Reset password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
