import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useOrgPreselect } from '@/hooks/use-org-preselect';
import { API_URL } from '@/lib/api/core';
import { useAuthState } from '@/lib/auth-state';
import { pruneSearch } from '@/lib/router-search';

type DeviceSearchParams = {
  user_code?: string;
};

export const Route = createFileRoute('/oauth/device')({
  component: DeviceConsentPage,
  validateSearch: (search: Record<string, unknown>): DeviceSearchParams =>
    pruneSearch({
      user_code:
        typeof search.user_code === 'string' && search.user_code.trim().length > 0
          ? search.user_code.trim()
          : undefined,
    }),
});

function DeviceConsentPage() {
  const search = Route.useSearch();
  const { session, isReady: authReady } = useAuthState();
  const sessionLoading = !authReady;
  const { orgList, selectedOrgId, setSelectedOrgId, orgsLoading } = useOrgPreselect();
  const [userCode, setUserCode] = useState(search.user_code || '');
  const [submitState, setSubmitState] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (!session) {
      const loginUrl = new URL('/auth/login', window.location.origin);
      loginUrl.searchParams.set('callbackUrl', window.location.href);
      window.location.href = loginUrl.toString();
    }
  }, [session, sessionLoading]);

  const submitConsent = async (approved: boolean) => {
    const code = userCode.trim().toUpperCase();
    if (!code) {
      setError('Please enter the code shown in your terminal.');
      return;
    }

    setSubmitState(approved ? 'approve' : 'deny');
    setError(null);

    try {
      const response = await fetch(`${API_URL}/oauth/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          user_code: code,
          approved,
          ...(approved && selectedOrgId ? { organization_id: selectedOrgId } : {}),
        }),
      });

      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;

      if (response.status === 401) {
        const loginUrl = new URL('/auth/login', window.location.origin);
        loginUrl.searchParams.set('callbackUrl', window.location.href);
        window.location.href = loginUrl.toString();
        return;
      }

      if (data?.error === 'org_selection_required') {
        setSubmitState(null);
        setError('Please select a workspace before approving.');
        return;
      }

      if (!response.ok) {
        throw new Error(
          (typeof data?.error_description === 'string' && data.error_description) ||
            (typeof data?.error === 'string' && data.error) ||
            'Failed to process device authorization'
        );
      }

      setDone(approved ? 'approved' : 'denied');
    } catch (err) {
      setSubmitState(null);
      setError(err instanceof Error ? err.message : 'Unexpected error');
    }
  };

  if (sessionLoading || !session) {
    return (
      <main className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Checking authentication...</p>
      </main>
    );
  }

  if (done) {
    return (
      <main className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-4">
        <Card className="w-full max-w-lg border shadow-sm">
          <CardHeader>
            <CardTitle>
              {done === 'approved' ? 'Device Authorized' : 'Authorization Denied'}
            </CardTitle>
            <CardDescription>
              {done === 'approved'
                ? 'You can close this tab and return to your terminal.'
                : 'The device was not authorized. You can close this tab.'}
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border shadow-sm">
        <CardHeader>
          <CardTitle>Authorize Device</CardTitle>
          <CardDescription>
            Enter the code shown in your terminal to connect your device.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="user-code" className="text-sm font-medium">
              Device code
            </label>
            <Input
              id="user-code"
              value={userCode}
              onChange={(e) => setUserCode(e.target.value.toUpperCase())}
              placeholder="ABCD-1234"
              className="font-mono text-center text-lg tracking-widest"
              maxLength={9}
              autoFocus={!search.user_code}
            />
          </div>

          {!orgsLoading && orgList.length > 0 && (
            <div className="space-y-2">
              <label htmlFor="org-select" className="text-sm font-medium">
                Workspace
              </label>
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                <SelectTrigger id="org-select">
                  <SelectValue placeholder="Select a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {orgList.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => submitConsent(false)}
              disabled={submitState !== null || !userCode.trim()}
            >
              {submitState === 'deny' ? 'Denying...' : 'Deny'}
            </Button>
            <Button
              type="button"
              onClick={() => submitConsent(true)}
              disabled={
                submitState !== null || !userCode.trim() || (!selectedOrgId && orgList.length > 0)
              }
            >
              {submitState === 'approve' ? 'Approving...' : 'Approve'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
