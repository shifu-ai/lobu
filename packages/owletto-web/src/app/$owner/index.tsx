import { createFileRoute } from '@tanstack/react-router';
import { OwnerResolver } from '@/components/owner-resolver';
import { pruneSearch } from '@/lib/router-search';

export const Route = createFileRoute('/$owner/')({
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      editEntityTypes:
        typeof search.editEntityTypes === 'string' ? search.editEntityTypes : undefined,
    }),
  component: OwnerIndex,
});

function OwnerIndex() {
  const { owner } = Route.useParams();

  return <OwnerResolver owner={owner} />;
}
