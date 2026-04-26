import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { OwnerTabPage } from '@/components/owner-tab-page';

const EventsTab = lazy(async () => ({
  default: (await import('@/components/entity-tabs/events-tab')).EventsTab,
}));

export const Route = createFileRoute('/$owner/events/')({
  component: EventsPage,
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | undefined>,
});

function EventsPage() {
  const { owner } = Route.useParams();

  return (
    <OwnerTabPage owner={owner} tabSegment="events" title="Knowledge">
      {(props) => (
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading...
            </div>
          }
        >
          <EventsTab {...props} />
        </Suspense>
      )}
    </OwnerTabPage>
  );
}
