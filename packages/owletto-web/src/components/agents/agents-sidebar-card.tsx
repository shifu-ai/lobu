import { Bot, Plus, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AgentItem } from '@/lib/api/agents';
import { cn } from '@/lib/utils';
import { statusTone } from './ui-utils';

// Discriminated union so TypeScript enforces that callers pass
// `allClientsCount` whenever they enable the "All Clients" row.
type AllClientsProps =
  | { showAllClientsOption: true; allClientsCount: number; getAllClientsHref?: () => string }
  | { showAllClientsOption?: false; allClientsCount?: never; getAllClientsHref?: never };

type AgentsSidebarCardProps = {
  agents: AgentItem[];
  title?: string;
  description?: ReactNode;
  headerAction?: ReactNode;
  selectedAgentId?: string | null;
  emptyStateText?: string;
  isLoading?: boolean;
  onCreateAgent?: (() => void) | null;
  canCreateAgent?: boolean;
  onSelectAgent?: ((agentId: string | null) => void) | null;
  onOpenAgent?: ((agentId: string) => void) | null;
  getAgentHref?: ((agentId: string) => string) | null;
  footer?: ReactNode;
} & AllClientsProps;

function AgentSummary({ agent }: { agent: AgentItem }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{agent.name}</span>
        <Badge variant="outline" className={statusTone(agent.status)}>
          {agent.status}
        </Badge>
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {agent.clientCount} client{agent.clientCount === 1 ? '' : 's'} ·{' '}
        {agent.activeConnectionCount} active connection
        {agent.activeConnectionCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}

// Using plain <a> rather than <Link to={href as '/'}>: hrefs in this card
// are computed strings that TanStack Router's typed `to` can't validate
// anyway, so the cast would only paper over bugs.
function AllClientsRow({
  count,
  selected,
  onSelect,
  href,
}: {
  count: number;
  selected: boolean;
  onSelect?: (() => void) | null;
  href?: string | null;
}) {
  const className = cn(
    'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors',
    selected ? 'border-foreground bg-muted/40' : 'hover:bg-muted/40'
  );

  const content = (
    <>
      <div>
        <div className="text-sm font-medium">All Clients</div>
        <div className="text-xs text-muted-foreground">No agent filter</div>
      </div>
      <Badge variant="outline">{count}</Badge>
    </>
  );

  if (href) {
    return (
      <a href={href} className={className}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" className={className} onClick={onSelect ?? undefined}>
      {content}
    </button>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
  onOpen,
  href,
  showOpenAction,
}: {
  agent: AgentItem;
  selected: boolean;
  onSelect?: (() => void) | null;
  onOpen?: (() => void) | null;
  href?: string | null;
  showOpenAction: boolean;
}) {
  const rowClassName = cn(
    'flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
    selected ? 'border-foreground bg-muted/40' : 'hover:bg-muted/40'
  );

  const showSettings = showOpenAction && Boolean(onOpen);

  // If the settings button is shown, the row wrapper can't be a button (no
  // nested interactive elements), so we fall back to a div + inner button.
  // Otherwise the whole row is a single clickable target.
  if (showSettings) {
    return (
      <div className={rowClassName}>
        {href ? (
          <a href={href} className="min-w-0 flex-1">
            <AgentSummary agent={agent} />
          </a>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={onSelect ?? onOpen ?? undefined}
          >
            <AgentSummary agent={agent} />
          </button>
        )}

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onOpen ?? undefined}
        >
          <Settings2 className="h-4 w-4" />
          <span className="sr-only">Edit {agent.name}</span>
        </Button>
      </div>
    );
  }

  if (href) {
    return (
      <a href={href} className={rowClassName}>
        <AgentSummary agent={agent} />
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cn(rowClassName, 'w-full text-left')}
      onClick={onSelect ?? onOpen ?? undefined}
    >
      <AgentSummary agent={agent} />
    </button>
  );
}

export function AgentsSidebarCard(props: AgentsSidebarCardProps) {
  const {
    agents,
    title = 'Always-On Agents',
    description,
    headerAction,
    selectedAgentId = null,
    emptyStateText = 'No agents yet.',
    isLoading = false,
    onCreateAgent = null,
    canCreateAgent = true,
    onSelectAgent = null,
    onOpenAgent = null,
    getAgentHref = null,
    footer,
  } = props;

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Bot className="h-5 w-5" />
              {title}
            </CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {onCreateAgent ? (
            <Button size="sm" onClick={onCreateAgent} disabled={!canCreateAgent}>
              <Plus className="h-4 w-4" />
              New Agent
            </Button>
          ) : (
            headerAction
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-2">
        {props.showAllClientsOption ? (
          <AllClientsRow
            count={props.allClientsCount}
            selected={selectedAgentId === null}
            onSelect={onSelectAgent ? () => onSelectAgent(null) : null}
            href={props.getAllClientsHref ? props.getAllClientsHref() : null}
          />
        ) : null}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading agents...</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyStateText}</p>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => (
              <AgentRow
                key={agent.agentId}
                agent={agent}
                selected={selectedAgentId === agent.agentId}
                onSelect={onSelectAgent ? () => onSelectAgent(agent.agentId) : null}
                onOpen={onOpenAgent ? () => onOpenAgent(agent.agentId) : null}
                href={getAgentHref ? getAgentHref(agent.agentId) : null}
                showOpenAction={Boolean(onOpenAgent)}
              />
            ))}
          </div>
        )}

        {footer}
      </CardContent>
    </Card>
  );
}
