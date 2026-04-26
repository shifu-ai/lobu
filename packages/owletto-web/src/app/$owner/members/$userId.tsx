import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/$owner/members/$userId')({
  component: MemberDetailRedirect,
});

function MemberDetailRedirect() {
  const { owner, userId: memberSlug } = Route.useParams();
  return <Navigate to={`/${owner}/%24member/${memberSlug}` as '/'} replace />;
}
