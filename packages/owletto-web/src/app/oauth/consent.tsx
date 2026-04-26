import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { validateOAuthRedirectUrl } from '@/lib/url';

type ConsentSearchParams = {
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  client_name?: string;
  resource?: string;
};

type ConsentApiResponse = {
  redirect_url?: string;
  error?: string;
  error_description?: string;
  message?: string;
  organizations?: Array<{ id: string; name: string; slug: string }>;
};

const REQUIRED_PARAMS: Array<keyof ConsentSearchParams> = [
  'client_id',
  'redirect_uri',
  'scope',
  'code_challenge',
  'code_challenge_method',
];

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export const Route = createFileRoute('/oauth/consent')({
  component: OAuthConsentPage,
  validateSearch: (search: Record<string, unknown>): ConsentSearchParams =>
    pruneSearch({
      client_id: stringParam(search.client_id),
      redirect_uri: stringParam(search.redirect_uri),
      scope: stringParam(search.scope),
      state: stringParam(search.state),
      code_challenge: stringParam(search.code_challenge),
      code_challenge_method: stringParam(search.code_challenge_method),
      client_name: stringParam(search.client_name),
      resource: stringParam(search.resource),
    }),
});

function OAuthConsentPage() {
  const search = Route.useSearch();
  const { session, isReady: authReady } = useAuthState();
  const sessionLoading = !authReady;
  const { orgList, selectedOrgId, setSelectedOrgId, orgsLoading } = useOrgPreselect();
  const [submitState, setSubmitState] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (!session) {
      const loginUrl = new URL('/auth/login', window.location.origin);
      loginUrl.searchParams.set('callbackUrl', window.location.href);
      window.location.href = loginUrl.toString();
    }
  }, [session, sessionLoading]);

  const missingParams = useMemo(
    () => REQUIRED_PARAMS.filter((key) => !search[key] || search[key]?.length === 0),
    [search]
  );
  const canSubmit = missingParams.length === 0;
  const clientDisplayName = search.client_name || search.client_id || 'Unknown client';
  const scopes = useMemo(() => {
    return (search.scope || '')
      .split(' ')
      .map((scope) => scope.trim())
      .filter(Boolean);
  }, [search.scope]);
  const hasMcpScopes = useMemo(() => scopes.some((scope) => scope.startsWith('mcp:')), [scopes]);
  const requestedMcpAccess = useMemo(() => {
    if (scopes.includes('mcp:admin')) return 'admin';
    if (scopes.includes('mcp:write')) return 'write';
    if (scopes.includes('mcp:read')) return 'read';
    return null;
  }, [scopes]);
  const resourceOrg = useMemo(() => {
    if (!search.resource) return null;
    try {
      const parsed = new URL(search.resource);
      const pathMatch = parsed.pathname.match(/^\/mcp\/([^/]+)$/);
      const orgFromPath = pathMatch?.[1]?.trim();
      if (orgFromPath) return orgFromPath;

      const orgFromQuery = parsed.searchParams.get('org')?.trim();
      return orgFromQuery ? orgFromQuery : null;
    } catch {
      return null;
    }
  }, [search.resource]);

  const redirectToLogin = () => {
    const loginUrl = new URL('/auth/login', window.location.origin);
    loginUrl.searchParams.set('callbackUrl', window.location.href);
    window.location.href = loginUrl.toString();
  };

  const submitConsent = async (approved: boolean) => {
    if (!canSubmit) {
      setError(`Missing required query params: ${missingParams.join(', ')}`);
      return;
    }

    setSubmitState(approved ? 'approve' : 'deny');
    setError(null);

    try {
      const response = await fetch(`${API_URL}/oauth/authorize/consent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          client_id: search.client_id,
          redirect_uri: search.redirect_uri,
          scope: search.scope,
          state: search.state ?? '',
          code_challenge: search.code_challenge,
          code_challenge_method: search.code_challenge_method,
          client_name: search.client_name,
          resource: search.resource,
          approved,
          ...(approved && hasMcpScopes && selectedOrgId ? { organization_id: selectedOrgId } : {}),
        }),
      });

      const data = (await response.json().catch(() => null)) as ConsentApiResponse | null;

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (data?.error === 'org_selection_required') {
        setSubmitState(null);
        setError('Please select a workspace before approving.');
        return;
      }

      if (!response.ok) {
        throw new Error(
          data?.error_description ||
            data?.message ||
            data?.error ||
            `Failed to ${approved ? 'approve' : 'deny'} OAuth consent`
        );
      }

      const safeRedirect = validateOAuthRedirectUrl(data?.redirect_url);
      if (!safeRedirect) {
        throw new Error('Consent response did not include a valid redirect URL');
      }

      window.location.href = safeRedirect;
    } catch (err) {
      setSubmitState(null);
      setError(err instanceof Error ? err.message : 'Unexpected error while submitting consent');
    }
  };

  if (sessionLoading || !session) {
    return (
      <main className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Checking authentication...</p>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border shadow-sm">
        <CardHeader>
          <CardTitle>Authorize Application</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">{clientDisplayName}</span> is requesting
            access to your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <section>
            <p className="text-sm font-medium mb-2">Requested permissions</p>
            {scopes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No scopes provided.</p>
            ) : (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {scopes.map((scope) => (
                  <li key={scope} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                    <span className="font-mono">{scope}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {hasMcpScopes && !resourceOrg && !orgsLoading && orgList.length > 0 && (
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

          {(resourceOrg || search.resource) && (
            <section className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground space-y-1">
              {resourceOrg && (
                <p>
                  Organization: <span className="font-medium text-foreground">{resourceOrg}</span>
                </p>
              )}
              {search.resource && (
                <p>
                  Resource: <span className="font-medium text-foreground">{search.resource}</span>
                </p>
              )}
            </section>
          )}

          {hasMcpScopes && !resourceOrg && (
            <section className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm space-y-2">
              <p className="font-medium text-foreground">Multi-workspace access</p>
              <p className="text-muted-foreground">
                No workspace is selected yet. After approving, you can switch between any workspace
                you're a member of. No workspace data is accessible until you select one.
              </p>
            </section>
          )}

          {hasMcpScopes && resourceOrg && (
            <section className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm space-y-2">
              <p className="font-medium text-foreground">Workspace access after approval</p>
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  If this workspace is public, the app can read public data immediately after
                  approval.
                </li>
                {requestedMcpAccess === 'write' && (
                  <li>
                    If you are not already a member, this connection will stay read-only. Ask an
                    organization admin to grant write access, then reconnect the MCP client.
                  </li>
                )}
                {requestedMcpAccess === 'admin' && (
                  <li>
                    If you are not already an admin or owner, elevated actions will stay blocked.
                    Ask an organization owner to grant the required role, then reconnect the MCP
                    client.
                  </li>
                )}
                {requestedMcpAccess === 'read' && (
                  <li>Public read access does not require membership.</li>
                )}
              </ul>
            </section>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!canSubmit && (
            <p className="text-sm text-destructive">
              Missing required query params: {missingParams.join(', ')}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => submitConsent(false)}
              disabled={submitState !== null}
            >
              {submitState === 'deny' ? 'Denying...' : 'Deny'}
            </Button>
            <Button
              type="button"
              onClick={() => submitConsent(true)}
              disabled={
                submitState !== null ||
                (hasMcpScopes && !resourceOrg && !selectedOrgId && orgList.length > 0)
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
