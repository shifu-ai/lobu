import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuthRun } from '@/lib/api/connections';
import { ArtifactRenderer } from './auth-artifact-renderer';

interface AuthFlowDialogProps {
  runId: number | null;
  onClose: () => void;
}

export function AuthFlowDialog({ runId, onClose }: AuthFlowDialogProps) {
  const { data: run, isLoading } = useAuthRun(runId);

  const isTerminal = useMemo(
    () => run?.status === 'completed' || run?.status === 'failed' || run?.status === 'cancelled',
    [run?.status]
  );

  useEffect(() => {
    if (run?.status === 'completed') {
      const t = setTimeout(onClose, 1500);
      return () => clearTimeout(t);
    }
  }, [run?.status, onClose]);

  const open = runId != null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {run?.status === 'completed'
              ? 'Connection authorized'
              : run?.status === 'failed'
                ? 'Authorization failed'
                : run?.status === 'cancelled'
                  ? 'Authorization cancelled'
                  : 'Connect your account'}
          </DialogTitle>
          <DialogDescription>
            {run?.connector_key
              ? `Complete sign-in for ${run.connector_key} to finish setup. You can add feeds later if you want scheduled syncs.`
              : 'Complete sign-in to finish setup. You can add feeds later if you want scheduled syncs.'}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-4">
          {isLoading && !run && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
            </div>
          )}

          {run?.status === 'completed' && (
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle2 className="h-5 w-5" /> Success — closing…
            </div>
          )}

          {run?.status === 'failed' && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{run.error_message || 'Authentication failed.'}</span>
            </div>
          )}

          {run?.status === 'cancelled' && (
            <div className="rounded-md border p-3 text-sm text-muted-foreground flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Authorization was cancelled.</span>
            </div>
          )}

          {!isTerminal && run && !run.artifact && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Waiting for connector…
            </div>
          )}

          {!isTerminal && run?.artifact && runId != null && (
            <ArtifactRenderer artifact={run.artifact} runId={runId} />
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {isTerminal ? 'Close' : 'Cancel'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
