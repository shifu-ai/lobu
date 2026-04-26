import { Link } from '@tanstack/react-router';
import { Bot, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface NoWindowsEmptyStateProps {
  ownerSlug?: string;
  showAgentsCta?: boolean;
}

export function NoWindowsEmptyState({
  ownerSlug,
  showAgentsCta = false,
}: NoWindowsEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center text-muted-foreground">
      <Layers className="mb-4 h-12 w-12 opacity-50" />
      <p className="text-lg font-medium text-foreground">No analysis windows yet</p>
      <p className="mt-1 max-w-md text-sm">
        Windows will appear here once this watcher has processed content.
      </p>
      {showAgentsCta && ownerSlug ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          <p className="max-w-md text-sm">
            You can connect agents from the Agents page to run watcher analysis.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to={`/${ownerSlug}/agents` as '/'}>
              <Bot className="h-4 w-4" />
              Connect agents
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
