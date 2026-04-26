import { AlertCircle, CheckCircle2, ChevronRight, Clock, Loader2, Play, Zap } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { ExecuteActionResult } from '@/lib/api';
import { useAvailableOperations, useExecuteAction } from '@/lib/api';
import { DynamicConnectorForm } from './dynamic-connector-form';

interface ActionRunnerProps {
  connectionId: number;
}

export function ActionRunner({ connectionId }: ActionRunnerProps) {
  const { data: operations = [] } = useAvailableOperations(connectionId);
  const entries = operations.filter((operation) => operation.kind === 'write');
  const [actionInputs, setActionInputs] = useState<Record<string, Record<string, unknown>>>({});
  const [actionResults, setActionResults] = useState<Record<string, ExecuteActionResult>>({});
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const executeAction = useExecuteAction();

  const handleInputChange = useCallback((actionKey: string, values: Record<string, unknown>) => {
    setActionInputs((prev) => ({ ...prev, [actionKey]: values }));
  }, []);

  const handleRun = async (actionKey: string) => {
    setRunningAction(actionKey);
    setActionResults((prev) => {
      const next = { ...prev };
      delete next[actionKey];
      return next;
    });
    try {
      const result = await executeAction.mutateAsync({
        connection_id: connectionId,
        operation_key: actionKey,
        input: actionInputs[actionKey] ?? {},
      });
      setActionResults((prev) => ({ ...prev, [actionKey]: result }));
    } catch (error) {
      setActionResults((prev) => ({
        ...prev,
        [actionKey]: {
          run_id: 0,
          status: 'failed',
          error_message: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setRunningAction(null);
    }
  };

  if (entries.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Zap className="h-3 w-3" />
        Actions
      </p>
      <div className="space-y-2">
        {entries.map((operation) => {
          const actionKey = operation.operation_key;
          const isRunning = runningAction === actionKey;
          const result = actionResults[actionKey];
          return (
            <Collapsible key={actionKey}>
              <CollapsibleTrigger className="flex items-center gap-1 text-sm w-full text-left group">
                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                <span className="font-medium">{operation.name ?? actionKey}</span>
                {operation.description && (
                  <span className="text-muted-foreground ml-1">
                    &mdash; {operation.description}
                  </span>
                )}
                {operation.requires_approval && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                    Requires approval
                  </Badge>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-4 mt-1.5 space-y-3">
                  {operation.input_schema && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Input</p>
                      <DynamicConnectorForm
                        schema={operation.input_schema}
                        onValuesChange={(values) => handleInputChange(actionKey, values)}
                        fieldIdPrefix={`action-${actionKey}-`}
                      />
                    </div>
                  )}
                  {operation.output_schema && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Output Schema</p>
                      <DynamicConnectorForm schema={operation.output_schema} readOnly />
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRun(actionKey)}
                    disabled={isRunning || runningAction !== null}
                  >
                    {isRunning ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Running...
                      </>
                    ) : (
                      <>
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                        Run
                      </>
                    )}
                  </Button>
                  {result && <ActionResult result={result} />}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

function ActionResult({ result }: { result: ExecuteActionResult }) {
  if (result.status === 'completed') {
    return (
      <div className="rounded-md bg-green-50 dark:bg-green-950/30 p-3 text-sm space-y-1">
        <div className="flex items-center gap-1.5 text-green-700 dark:text-green-400 font-medium">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Completed
          <span className="text-xs font-normal text-muted-foreground ml-auto">
            Run #{result.run_id}
          </span>
        </div>
        {result.output && Object.keys(result.output).length > 0 && (
          <pre className="text-xs text-green-800 dark:text-green-300 font-mono whitespace-pre-wrap mt-1">
            {JSON.stringify(result.output, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (result.status === 'pending_approval') {
    return (
      <div className="rounded-md bg-yellow-50 dark:bg-yellow-950/30 p-3 text-sm">
        <div className="flex items-center gap-1.5 text-yellow-700 dark:text-yellow-400 font-medium">
          <Clock className="h-3.5 w-3.5" />
          Pending Approval
          <span className="text-xs font-normal text-muted-foreground ml-auto">
            Run #{result.run_id}
          </span>
        </div>
        {result.message && (
          <p className="text-xs text-yellow-800 dark:text-yellow-300 mt-1">{result.message}</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm">
      <div className="flex items-center gap-1.5 text-red-700 dark:text-red-400 font-medium">
        <AlertCircle className="h-3.5 w-3.5" />
        Failed
        {result.run_id > 0 && (
          <span className="text-xs font-normal text-muted-foreground ml-auto">
            Run #{result.run_id}
          </span>
        )}
      </div>
      {result.error_message && (
        <p className="text-xs text-red-800 dark:text-red-300 font-mono mt-1">
          {result.error_message}
        </p>
      )}
    </div>
  );
}
