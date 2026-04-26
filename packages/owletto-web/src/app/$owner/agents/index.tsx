import { createFileRoute } from '@tanstack/react-router';
import { AgentsPageView } from '@/components/agents/agents-page-view';
import { pruneSearch } from '@/lib/router-search';

export const Route = createFileRoute('/$owner/agents/')({
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      create: search.create === true || search.create === 'true' ? true : undefined,
    }),
  component: AgentsPageRoute,
});

function AgentsPageRoute() {
  const { owner } = Route.useParams();
  const search = Route.useSearch();

  return <AgentsPageView owner={owner} createMode={search.create === true} />;
}
