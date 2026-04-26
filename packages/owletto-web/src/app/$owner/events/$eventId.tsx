import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/$owner/events/$eventId')({
  beforeLoad: ({ params }) => {
    // Redirect to events page filtered by content_id.
    // Use window.location to avoid TanStack Router's JSON search serialization
    // which wraps string values in quotes.
    const target = `/${params.owner}/events?content_ids=${params.eventId}`;
    if (typeof window !== 'undefined') {
      window.location.replace(target);
    }
  },
  component: () => null,
});
