import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Database, Lightbulb, Link2, Users } from 'lucide-react';
import { AgentsSidebarCard } from '@/components/agents/agents-sidebar-card';
import {
  buildConnectorDefinitionMap,
  ConnectorDisplay,
  resolveConnectorDisplay,
} from '@/components/connectors/connector-display';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { BootstrapContentItem, ResolvePathBootstrap } from '@/lib/api';
import { useAgents } from '@/lib/api/agents';
import { organization } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';
import { formatTimeAgo } from '@/lib/format-utils';
import { Sparkline } from '@/lib/json-renderer/charts';
import { byDateDesc } from '@/lib/string-utils';
import { cn } from '@/lib/utils';

function formatStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  return status.replaceAll('_', ' ');
}

function getKnowledgeTitle(item: BootstrapContentItem): string {
  const title = item.title?.trim();
  if (title) return title;

  const text = item.text_content?.trim() ?? '';
  if (!text) return 'Untitled knowledge item';

  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function SectionLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to as '/'}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80"
    >
      {label}
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">{value}</span> {label}
    </span>
  );
}

function startOfDay(dateInput: string | null | undefined): string | null {
  if (!dateInput) return null;
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function buildDailySeries(dateInputs: Array<string | null | undefined>, days = 14): number[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets = new Map<string, number>();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    buckets.set(date.toISOString().slice(0, 10), 0);
  }

  for (const dateInput of dateInputs) {
    const key = startOfDay(dateInput);
    if (!key || !buckets.has(key)) continue;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return Array.from(buckets.values());
}

function getTrendDirection(series: number[]): 'up' | 'down' | 'stable' {
  if (series.length < 2) return 'stable';
  const midpoint = Math.floor(series.length / 2);
  const previous = series.slice(0, midpoint);
  const current = series.slice(midpoint);
  const previousAverage =
    previous.length > 0 ? previous.reduce((sum, value) => sum + value, 0) / previous.length : 0;
  const currentAverage =
    current.length > 0 ? current.reduce((sum, value) => sum + value, 0) / current.length : 0;

  if (currentAverage > previousAverage) return 'up';
  if (currentAverage < previousAverage) return 'down';
  return 'stable';
}

function getTrendSummary(series: number[]): { direction: 'up' | 'down' | 'stable'; delta: number } {
  const first = series[0] ?? 0;
  const last = series[series.length - 1] ?? 0;
  return { direction: getTrendDirection(series), delta: last - first };
}

function getTrendStyles(direction: 'up' | 'down' | 'stable'): {
  lineColor: string;
  textClassName: string;
  label: string;
} {
  if (direction === 'up') {
    return {
      lineColor: '#16a34a',
      textClassName: 'text-emerald-600',
      label: 'Up',
    };
  }

  if (direction === 'down') {
    return {
      lineColor: '#ea580c',
      textClassName: 'text-orange-600',
      label: 'Down',
    };
  }

  return {
    lineColor: '#64748b',
    textClassName: 'text-muted-foreground',
    label: 'Flat',
  };
}

function DashboardMetricCard({
  label,
  value,
  to,
  series,
  isLoading,
}: {
  label: string;
  value: number;
  to: string;
  series: number[];
  isLoading?: boolean;
}) {
  const trend = getTrendSummary(series);
  const trendStyles = getTrendStyles(trend.direction);
  const trendPrefix = trend.delta > 0 ? '+' : '';

  return (
    <Link
      to={to as '/'}
      className="block rounded-xl border bg-muted/20 px-4 py-3 transition-colors hover:bg-muted/35"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          {isLoading ? (
            <div className="mt-1 h-8 w-16 rounded bg-muted animate-pulse" />
          ) : (
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>
          )}
          <p className={`mt-1 text-xs font-medium ${trendStyles.textClassName}`}>
            {trendStyles.label}
            {' • '}
            {trendPrefix}
            {trend.delta}
            {' in 14d'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
          <div className="mt-3">
            <Sparkline data={series} width={96} height={34} color={trendStyles.lineColor} />
          </div>
        </div>
      </div>
    </Link>
  );
}

interface WorkspaceDashboardHomeProps {
  owner: string;
  headerContent?: React.ReactNode;
  sidebarContent?: React.ReactNode;
  entityBasePath?: string;
  bootstrap?: ResolvePathBootstrap | null;
}

export function WorkspaceDashboardHome({
  owner,
  headerContent,
  sidebarContent,
  entityBasePath,
  bootstrap,
}: WorkspaceDashboardHomeProps) {
  const basePath = entityBasePath ?? `/${owner}`;
  const connectorsPath = `${basePath}/connectors`;
  const knowledgePath = `${basePath}/events`;
  const watchersPath = `${basePath}/watchers`;

  const feeds = bootstrap?.recent_feeds ?? [];
  const connectorDefinitions = bootstrap?.connector_definitions ?? [];
  const watchers = [...(bootstrap?.recent_watchers ?? [])].sort((a, b) =>
    byDateDesc(a.updated_at || a.created_at, b.updated_at || b.created_at)
  );
  const summary = bootstrap?.summary;
  const connectorDefinitionsByKey = buildConnectorDefinitionMap(connectorDefinitions);

  const knowledgeItems = bootstrap?.recent_content ?? [];
  const recentKnowledge = knowledgeItems.slice(0, 5);
  const recentFeeds = feeds.slice(0, 5);
  const recentWatchers = watchers.slice(0, 5);
  const canOpenDetail = Boolean(entityBasePath);
  const summaryStats = [
    {
      label: 'Knowledge',
      value: summary?.total_content ?? knowledgeItems.length,
      to: knowledgePath,
      series: buildDailySeries(knowledgeItems.map((item) => item.occurred_at || item.created_at)),
    },
    {
      label: 'Connectors',
      value: summary?.active_connections ?? feeds.length,
      to: connectorsPath,
      series: buildDailySeries(feeds.map((feed) => feed.created_at)),
    },
    {
      label: 'Watchers',
      value: summary?.watchers_count ?? watchers.length,
      to: watchersPath,
      series: buildDailySeries(watchers.map((watcher) => watcher.updated_at || watcher.created_at)),
    },
  ];

  return (
    <div className={cn('grid gap-6', sidebarContent && 'xl:grid-cols-[minmax(0,1.5fr)_460px]')}>
      <div className="space-y-6">
        {headerContent}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {summaryStats.map((stat) => (
            <DashboardMetricCard
              key={stat.label}
              label={stat.label}
              value={stat.value}
              to={stat.to}
              series={stat.series}
            />
          ))}
        </div>

        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Link2 className="h-5 w-5" />
                  Feeds
                </CardTitle>
                <CardDescription>
                  Recent sync targets across your configured connectors.
                </CardDescription>
              </div>
              <SectionLink to={connectorsPath} label="Open connectors" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentFeeds.length === 0 ? (
              <EmptyState text="No feeds configured yet." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {recentFeeds.map((feed) => {
                  const connector = resolveConnectorDisplay(
                    feed.connector_key,
                    connectorDefinitionsByKey,
                    {
                      name: feed.connector_name || feed.connection_name || feed.connector_key,
                    }
                  );

                  return (
                    <Link
                      key={feed.id}
                      to={
                        (canOpenDetail
                          ? `${connectorsPath}/${feed.connector_key}`
                          : connectorsPath) as '/'
                      }
                      className="block rounded-xl border px-4 py-3 transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <ConnectorDisplay
                            connector={{
                              ...connector,
                              name: connector.name,
                            }}
                            showDescription={false}
                          />
                          <p className="text-sm text-foreground font-medium truncate">
                            {feed.display_name || feed.connection_name || connector.name}
                          </p>
                        </div>
                        <Badge variant="outline" className="shrink-0 capitalize">
                          {formatStatusLabel(feed.status)}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <StatChip label="events" value={feed.event_count ?? 0} />
                        <StatChip label="entities" value={feed.entity_ids?.length ?? 0} />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {feed.connection_name || connector.name}
                        {' • '}
                        {formatTimeAgo(feed.updated_at || feed.created_at)}
                      </p>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Lightbulb className="h-5 w-5" />
                  Watchers
                </CardTitle>
                <CardDescription>
                  Recent watchers that turn workspace knowledge into structured analysis.
                </CardDescription>
              </div>
              <SectionLink to={watchersPath} label="Open watchers" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentWatchers.length === 0 ? (
              <EmptyState text="No watchers configured yet." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {recentWatchers.map((watcher) => (
                  <Link
                    key={watcher.watcher_id}
                    to={
                      (canOpenDetail
                        ? `${watchersPath}/${watcher.watcher_id}`
                        : watchersPath) as '/'
                    }
                    className="block rounded-xl border px-4 py-3 transition-colors hover:bg-muted/30"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">{watcher.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {watcher.entity_name || 'Space-level'}
                        </p>
                      </div>
                      <Badge variant="outline" className="shrink-0 capitalize">
                        {formatStatusLabel(watcher.status)}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <StatChip label="windows" value={watcher.windows_count ?? 0} />
                      <StatChip label="cadence" value={watcher.schedule ?? 'manual'} />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {formatTimeAgo(watcher.updated_at || watcher.created_at)}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Database className="h-5 w-5" />
                  Recent Knowledge
                </CardTitle>
                <CardDescription>
                  The latest collected or saved knowledge across this workspace.
                </CardDescription>
              </div>
              <SectionLink to={knowledgePath} label="Open knowledge" />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {recentKnowledge.length === 0 ? (
              <EmptyState text="No knowledge collected yet." />
            ) : (
              recentKnowledge.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-xl border px-4 py-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium leading-6">{getKnowledgeTitle(item)}</p>
                    <p className="text-xs text-muted-foreground">
                      {[item.entity_name, item.platform || item.author_name]
                        .filter(Boolean)
                        .join(' • ') || 'Unknown source'}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground">
                    {formatTimeAgo(item.occurred_at || item.created_at)}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {sidebarContent && <div className="space-y-4">{sidebarContent}</div>}
    </div>
  );
}

export function OrgSidebar({
  orgId,
  ownerSlug,
  agentsPath,
}: {
  orgId: string;
  ownerSlug: string;
  agentsPath: string;
}) {
  const { data: agents = [], isLoading: isAgentsLoading } = useAgents();

  return (
    <>
      <MembersCard orgId={orgId} ownerSlug={ownerSlug} />
      <AgentsSidebarCard
        agents={agents}
        title="Agents"
        description={`Set up AI assistants and messaging bots`}
        headerAction={<SectionLink to={agentsPath} label="Manage" />}
        getAgentHref={(agentId) => `${agentsPath}/${agentId}`}
        isLoading={isAgentsLoading}
      />
    </>
  );
}

interface MemberSummary {
  id: string;
  role: string;
  user: { id: string; name: string; email: string; image?: string };
}

function MembersCard({ orgId, ownerSlug }: { orgId: string; ownerSlug: string }) {
  const { isAuthenticated } = useAuthState();
  const { data: members = [], isLoading } = useQuery({
    queryKey: ['workspace-dashboard-members', orgId],
    queryFn: async () => {
      const res = await organization.listMembers({ query: { organizationId: orgId } });
      return (res.data?.members as MemberSummary[]) ?? [];
    },
    enabled: isAuthenticated,
    staleTime: 60000,
  });

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Users className="h-5 w-5" />
              Members
            </CardTitle>
            <CardDescription>
              {members.length > 0
                ? `${members.length} member${members.length === 1 ? '' : 's'}`
                : 'Team members'}
            </CardDescription>
          </div>
          <SectionLink to={`/${ownerSlug}/members`} label="Manage" />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <EmptyState text="Loading members..." />
        ) : members.length === 0 ? (
          <EmptyState text="No members yet." />
        ) : (
          <div className="space-y-2">
            {members.slice(0, 8).map((m) => (
              <div key={m.id} className="flex items-center gap-2.5">
                {m.user.image ? (
                  <img
                    src={m.user.image}
                    alt={m.user.name}
                    referrerPolicy="no-referrer"
                    className="h-7 w-7 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {(m.user.name || m.user.email).charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium leading-tight">
                    {m.user.name || m.user.email}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 capitalize text-xs">
                  {m.role}
                </Badge>
              </div>
            ))}
            {members.length > 8 && (
              <p className="text-xs text-muted-foreground">+{members.length - 8} more</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
