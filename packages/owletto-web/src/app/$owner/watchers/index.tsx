import { createFileRoute, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { OwnerTabPage } from '@/components/owner-tab-page';
import { pruneSearch } from '@/lib/router-search';

const WatchersTab = lazy(async () => ({
  default: (await import('@/components/entity-tabs/watchers-tab')).WatchersTab,
}));

export const Route = createFileRoute('/$owner/watchers/')({
  component: WatchersPage,
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      create: (search.create as string) || undefined,
    }),
});

function WatchersPage() {
  const { owner } = Route.useParams();
  const { create } = useSearch({ from: '/$owner/watchers/' });

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
          <WatchersTab {...props} defaultCreateOpen={!!create} />
        </Suspense>
      )}
    </OwnerTabPage>
  );
}
