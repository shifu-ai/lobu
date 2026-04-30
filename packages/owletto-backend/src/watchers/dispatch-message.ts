import type { WatcherRunPayload } from '../utils/queue-helpers';

export function buildWatcherDispatchMessage(params: {
  watcherId: number; runId: number; agentId: string; sessionAgentId: string; payload: WatcherRunPayload;
}): string {
  const { watcherId, runId, agentId, sessionAgentId, payload } = params;
  const since = new Date(payload.window_start).toISOString().split('T')[0];
  const until = new Date(new Date(payload.window_end).getTime() - 1).toISOString().split('T')[0];
  const metadata = JSON.stringify(
    {
      executor: 'lobu-agent',
      agent_id: agentId,
      watcher_run_id: runId,
      dispatch_source: payload.dispatch_source,
      session_agent_id: sessionAgentId,
    },
    null,
    2
  );

  return `Run this Owletto watcher now using the Owletto MCP tools.

Watcher ID: ${watcherId}
Watcher run ID: ${runId}
Assigned agent ID: ${agentId}
Session agent ID: ${sessionAgentId}
Queued window start: ${payload.window_start}
Queued window end: ${payload.window_end}
Dispatch source: ${payload.dispatch_source}

Required steps:
1. Call read_knowledge with {"watcher_id": ${watcherId}, "since": "${since}", "until": "${until}"}.
2. Analyze the returned content using prompt_rendered and extraction_schema.
3. Call manage_watchers(action="complete_window") with the returned window_token and your extracted_data.
4. Include this run_metadata object in complete_window exactly, and add any extra provider/job fields you know:
${metadata}

If there is no content, do not fabricate results.`;
}
