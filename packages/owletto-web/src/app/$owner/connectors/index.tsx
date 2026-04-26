import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback } from 'react';
import { OwnerTabPage } from '@/components/owner-tab-page';

const ConnectorListView = lazy(async () => ({
  default: (await import('@/components/entity-tabs/connections-tab/connector-list-view'))
    .ConnectorListView,
}));

export const Route = createFileRoute('/$owner/connectors/')({
  component: ConnectorsPage,
});

function ConnectorsPage() {
  const { owner } = Route.useParams();
  const search = Route.useSearch() as Record<string, string>;
  const navigate = useNavigate();

  const clearSearchParams = useCallback(() => {
    if (search.connector || search.install) {
      void navigate({ to: '.', replace: true });
    }
  }, [search.connector, search.install, navigate]);

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
          <ConnectorListView
            organizationId={props.organizationId}
            ownerSlug={props.ownerSlug}
            onSelectConnector={(connectorKey) => {
              void navigate({
                to: `/${owner}/connectors/${connectorKey}` as '/',
              });
            }}
            initialConnectorKey={search.connector || search.install}
            onSheetClose={clearSearchParams}
          />
        </Suspense>
      )}
    </OwnerTabPage>
  );
}
