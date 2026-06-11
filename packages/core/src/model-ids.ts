/**
 * Centralized Claude model ID constants.
 *
 * Single source of truth for hardcoded Anthropic model IDs used across the
 * gateway, agent worker, and CLI. When bumping a model version, change it
 * here (and only here) so every consumer moves in lockstep.
 *
 * The bare `*_MODEL_ID` constants name the model snapshot itself; the
 * purpose-specific constants below them capture *why* a given site uses that
 * model. Reference the purpose-specific constant at call sites so different
 * roles can diverge later without a find-and-replace.
 */

/** Claude Sonnet 4 (2025-05-14 snapshot). */
export const CLAUDE_SONNET_4_MODEL_ID = "claude-sonnet-4-20250514";

/** Claude Opus 4 (2025-05-14 snapshot). */
export const CLAUDE_OPUS_4_MODEL_ID = "claude-opus-4-20250514";

/** Claude Haiku 3.5 (2024-10-22 snapshot). */
export const CLAUDE_HAIKU_3_5_MODEL_ID = "claude-haiku-3-5-20241022";

/** Claude Haiku 4.5 (2025-10-01 snapshot). */
export const CLAUDE_HAIKU_4_5_MODEL_ID = "claude-haiku-4-5-20251001";

/**
 * Default Claude model for agents when nothing else is configured.
 * Used as the fallback in the gateway's Claude OAuth module (when neither a
 * user preference nor AGENT_DEFAULT_MODEL is set), as the agent worker's
 * default model for the `anthropic` provider, and as the scaffold default in
 * `lobu init`.
 */
export const DEFAULT_AGENT_MODEL = CLAUDE_SONNET_4_MODEL_ID;

/**
 * Model used by the gateway's LLM egress/text judges. Fast + cheap; invoked
 * only when a rule with `action: "judge"` matches.
 */
export const EGRESS_JUDGE_MODEL = CLAUDE_HAIKU_4_5_MODEL_ID;
