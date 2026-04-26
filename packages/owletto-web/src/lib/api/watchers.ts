// Watcher types
export interface Watcher {
  watcher_id: string;
  name: string;
  slug?: string;
  status: string;
  version?: number;
  created_at: string;
  updated_at: string;
  schedule: string | null;
  next_run_at: string | null;
  agent_id: string | null;
  scheduler_client_id?: string | null;
  sources?: Array<{ name: string; query: string }>;
  entity_id: number;
  entity_type: string;
  entity_name: string;
  entity_slug: string;
  parent_id?: number | null;
  parent_name?: string | null;
  parent_slug?: string | null;
  parent_entity_type?: string | null;
  organization_slug?: string;
  current_version_id?: number;
  watcher_group_id?: number;
  source_watcher_id?: number | null;
  windows_count?: number;
  latest_window_end?: string;
  model_config?: Record<string, unknown>;
  tags?: string[];
  watcher_run_id?: number | null;
  watcher_run_status?:
    | 'pending'
    | 'claimed'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'timeout'
    | null;
  watcher_run_error?: string | null;
  watcher_run_created_at?: string | null;
  watcher_run_completed_at?: string | null;
  // Details (when include_details=true)
  description?: string;
  prompt?: string;
  extraction_schema?: Record<string, unknown>;
  json_template?: unknown;
  reaction_script?: string;
  classifiers?: unknown[];
  keying_config?: Record<string, unknown>;
  condensation_prompt?: string;
  condensation_window_count?: number;
  reactions_guidance?: string;
}

export interface WatcherListResult {
  watchers: Watcher[];
}
