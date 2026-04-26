-- Add diagnostic columns to runs so subprocess failures carry enough context
-- to diagnose without reading gateway pod logs.
--
-- output_tail: redacted tail (~16 KiB) of child stdout+stderr at exit.
-- exit_code:   subprocess exit code, NULL when terminated by IPC error path.
-- exit_signal: signal name (e.g. SIGKILL) when killed.
-- exit_reason: categorized — ok | error_message | timeout | oom | crash.
ALTER TABLE public.runs ADD COLUMN output_tail TEXT NULL;
ALTER TABLE public.runs ADD COLUMN exit_code INTEGER NULL;
ALTER TABLE public.runs ADD COLUMN exit_signal TEXT NULL;
ALTER TABLE public.runs ADD COLUMN exit_reason TEXT NULL;
