import { createFileRoute } from '@tanstack/react-router';
import { Filter, X } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { OwnerTabPage } from '@/components/owner-tab-page';
import { Button } from '@/components/ui/button';
import { pruneSearch } from '@/lib/router-search';

const ConnectorDetailView = lazy(async () => ({
  default: (await import('@/components/entity-tabs/connections-tab/connector-detail-view'))
    .ConnectorDetailView,
}));

export const Route = createFileRoute('/$owner/connectors/$connectorKey')({
  component: ConnectorDetailPage,
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      createdBy: typeof search.createdBy === 'string' ? search.createdBy : undefined,
    }),
});

function ConnectorDetailPage() {
  const { owner, connectorKey } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <OwnerTabPage owner={owner} tabSegment="connectors" title="Connectors">
      {(props) => (
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading...
            </div>
          }
        >
          {search.createdBy && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm mb-4">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Filtered by member</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 ml-auto"
                onClick={() => void navigate({ search: { createdBy: undefined }, replace: true })}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          <ConnectorDetailView
            organizationId={props.organizationId}
            ownerSlug={props.ownerSlug}
            connectorKey={connectorKey}
            createdBy={search.createdBy}
            onBack={() => {
              if (search.createdBy) {
                void navigate({ to: `/${owner}/members/${search.createdBy}` as '/' });
              } else {
                void navigate({ to: `/${owner}/connectors` as '/' });
              }
            }}
          />
        </Suspense>
      )}
    </OwnerTabPage>
  );
}
