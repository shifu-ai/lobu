import { createFileRoute } from '@tanstack/react-router';
import { AgentsPageView } from '@/components/agents/agents-page-view';

export const Route = createFileRoute('/$owner/agents/$agentId')({
  component: AgentDetailRoute,
});

function AgentDetailRoute() {
  const { owner, agentId } = Route.useParams();

  return <AgentsPageView owner={owner} openedAgentId={agentId} />;
}
