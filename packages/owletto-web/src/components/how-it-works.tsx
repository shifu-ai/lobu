import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Globe, Plug } from 'lucide-react';
import { useMemo } from 'react';
import { McpConnect } from '@/components/mcp-connect';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useOrgContext } from '@/hooks/use-org-context';
import { type Organization, useOrganizations } from '@/lib/api';

const ACTION_LINK_CLASS =
  'h-8 rounded-full border-primary/20 bg-primary/10 px-3 text-xs font-semibold text-foreground hover:border-primary/35 hover:bg-primary/15 hover:text-foreground';

function CTABlock({ isAuthenticated }: { isAuthenticated: boolean }) {
  if (isAuthenticated) {
    return null;
  }

  return (
    <Button asChild>
      <Link
        to="/auth/login"
        search={{
          callbackUrl: undefined,
          mode: undefined,
          error: undefined,
          errorDescription: undefined,
          loginHint: undefined,
          invitationOrg: undefined,
          intent: undefined,
        }}
      >
        Sign in to get started
      </Link>
    </Button>
  );
}

function PublicWorkspaces({ publicOrgs }: { publicOrgs: Organization[] }) {
  if (publicOrgs.length === 0) return null;

  return (
    <div id="public-workspaces" className="space-y-3 scroll-mt-6">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Explore public workspaces</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {publicOrgs.map((org) => (
          <Link key={org.id} to={`/${org.slug}` as '/'}>
            <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
              <CardContent className="flex items-center justify-between gap-3 py-4">
                <div className="flex items-center gap-3 min-w-0">
                  {org.logo ? (
                    <img
                      src={org.logo}
                      alt={org.name}
                      className="h-10 w-10 rounded-md object-cover shrink-0"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary text-sm font-semibold shrink-0">
                      {org.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <span className="text-sm font-medium truncate block">{org.name}</span>
                    {org.description && (
                      <span className="block text-xs leading-snug text-muted-foreground whitespace-normal break-words">
                        {org.description}
                      </span>
                    )}
                  </div>
                </div>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function GettingStarted({
  isAuthenticated,
  workspace,
  hasPublicWorkspaces,
}: {
  isAuthenticated: boolean;
  workspace: { slug: string; name: string } | null;
  hasPublicWorkspaces: boolean;
}) {
  const helperText = workspace
    ? `Quick actions open in ${workspace.name}.`
    : isAuthenticated
      ? hasPublicWorkspaces
        ? 'Choose a workspace from the top-left menu or from the public workspaces below.'
        : 'Choose a workspace from the top-left menu to use these actions.'
      : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">How it works</h2>
      </div>
      {helperText && <p className="text-sm text-muted-foreground">{helperText}</p>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-10">
        <div className="flex gap-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold shrink-0">
            1
          </span>
          <div>
            <p className="text-sm font-medium">Define your data model</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Create entity types for the things you care about: brands, products, competitors,
              topics.
            </p>
            {workspace && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm" className={ACTION_LINK_CLASS}>
                  <a href={`/${workspace.slug}?editEntityTypes=true`}>
                    Edit your entity types
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold shrink-0">
            2
          </span>
          <div>
            <p className="text-sm font-medium">Connect your data</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Use existing connectors to get data from 50+ sources or let your agent build custom
              connectors.
            </p>
            {workspace && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm" className={ACTION_LINK_CLASS}>
                  <a href={`/${workspace.slug}/connectors`}>
                    Browse connectors
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold shrink-0">
            3
          </span>
          <div>
            <p className="text-sm font-medium">Create watchers</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Watchers self-update your data, summarize it with AI, and take actions on a schedule
              you define.
            </p>
            {workspace && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm" className={ACTION_LINK_CLASS}>
                  <a href={`/${workspace.slug}/watchers`}>
                    Browse watchers
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function HowItWorks({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { data: orgs } = useOrganizations();
  const { activeOrg } = useOrgContext();

  const memberOrgs = useMemo(() => (orgs || []).filter((org) => org.is_member), [orgs]);
  const publicOrgs = useMemo(
    () => (orgs || []).filter((org) => org.visibility === 'public'),
    [orgs]
  );
  const workspace = useMemo(() => {
    if (activeOrg?.slug) {
      return {
        slug: activeOrg.slug,
        name: activeOrg.name || activeOrg.slug,
      };
    }

    const fallbackOrg = memberOrgs[0];
    return fallbackOrg
      ? {
          slug: fallbackOrg.slug,
          name: fallbackOrg.name,
        }
      : null;
  }, [activeOrg?.name, activeOrg?.slug, memberOrgs]);

  return (
    <div className="flex flex-1 flex-col items-center py-8 md:py-12 px-4 gap-10">
      {/* Hero */}
      <div className="w-full max-w-3xl text-center space-y-3">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          Where your AI agents gather, reason, and act
        </h1>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Lobu memory lets your agents connect your data sources, organize knowledge around the things
          you care about, and gives your AI agents a persistent memory they can actually use.
        </p>
      </div>

      {/* What's next */}
      <div className="w-full max-w-3xl">
        <GettingStarted
          isAuthenticated={isAuthenticated}
          workspace={workspace}
          hasPublicWorkspaces={publicOrgs.length > 0}
        />
      </div>

      {/* Public Workspaces */}
      <div className="w-full max-w-5xl">
        <PublicWorkspaces publicOrgs={publicOrgs} />
      </div>

      {/* Connect your AI agent */}
      <div className="w-full max-w-3xl space-y-3">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Connect your AI agent</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Pick your client and connect it to Lobu memory via MCP. Once connected, your agent can manage
          everything else.
        </p>
        <McpConnect orgSlug={workspace?.slug} />
      </div>

      {/* Bottom CTA */}
      <div className="w-full max-w-3xl text-center pt-2 pb-4">
        <CTABlock isAuthenticated={isAuthenticated} />
      </div>
    </div>
  );
}
