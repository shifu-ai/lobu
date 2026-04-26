import { createFileRoute } from '@tanstack/react-router';
import { OwnerResolver } from '@/components/owner-resolver';

// Search params for entity tabs
// Values are kept as their parsed types (numbers stay numbers) so TanStack Router
// doesn't JSON-encode numeric strings like "172" -> %22172%22
type EntitySearchParams = Record<string, string | number | undefined>;

export const Route = createFileRoute('/$owner/$')({
  component: OwnerEntityRoute,
  validateSearch: (search: Record<string, unknown>): EntitySearchParams => {
    const result: EntitySearchParams = {};

    const knownParams = [
      'q',
      'page',
      'platforms',
      'date_start',
      'date_end',
      'engagement_min',
      'engagement_max',
      'classifications',
      'sort_by',
      'sort_order',
      'review_status',
      'since',
      'until',
      'granularity',
      'version',
      'window_id',
      'content_ids',
      'section',
    ];

    for (const key of knownParams) {
      const val = search[key];
      if (val != null) {
        result[key] = typeof val === 'number' ? val : String(val);
      }
    }

    for (const key of Object.keys(search)) {
      if (key.startsWith('clf_') && search[key] != null) {
        result[key] = String(search[key]);
      }
    }

    return result;
  },
});

function OwnerEntityRoute() {
  const { owner, _splat } = Route.useParams();
  return <OwnerResolver owner={owner} splat={_splat || ''} />;
}
