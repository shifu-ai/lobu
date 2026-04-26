import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { OwnerTabPage } from '@/components/owner-tab-page';

const WatchersTab = lazy(async () => ({
  default: (await import('@/components/entity-tabs/watchers-tab')).WatchersTab,
}));

export const Route = createFileRoute('/$owner/watchers/$watcherId')({
  component: WatcherDetailPage,
});

function WatcherDetailPage() {
  const { owner, watcherId } = Route.useParams();

  return (
    <OwnerTabPage owner={owner} tabSegment="watchers" title="Watchers">
      {(props) => (
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading...
            </div>
          }
        >
          <WatchersTab {...props} watcherId={watcherId} onItemName={props.setItemName} />
        </Suspense>
      )}
    </OwnerTabPage>
  );
}
