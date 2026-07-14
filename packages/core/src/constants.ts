#!/usr/bin/env bun

/**
 * Shared constants across all packages
 * These are platform-agnostic and used by core, gateway, and platform adapters
 */

// Time constants (milliseconds)
export const TIME = {
  /** One hour in milliseconds */
  HOUR_MS: 60 * 60 * 1000,
  /** One day in milliseconds */
  DAY_MS: 24 * 60 * 60 * 1000,
  /** One hour in seconds */
  HOUR_SECONDS: 3600,
  /** One day in seconds */
  DAY_SECONDS: 24 * 60 * 60,
  /** Five seconds in milliseconds */
  FIVE_SECONDS_MS: 5000,
  /** Thirty seconds */
  THIRTY_SECONDS: 30,
} as const;

/**
 * MCP protocol version this codebase advertises on `initialize` handshakes.
 * Kept in one place so the gateway, CLI, and openclaw plugin stay in lockstep.
 */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

/**
 * Automation MCP names that may mutate or expose a user's scheduled work.
 * Worker discovery and gateway execution both consume this single contract so
 * a newly protected operation cannot be omitted at one trust boundary.
 */
export const RESERVED_AUTOMATION_TOOL_NAMES = [
  "plan_automation",
  "create_automation",
  "list_automations",
  "cancel_automation",
] as const;

const RESERVED_AUTOMATION_TOOL_NAME_SET = new Set<string>(
  RESERVED_AUTOMATION_TOOL_NAMES
);

export function isReservedAutomationToolName(name: string): boolean {
  return RESERVED_AUTOMATION_TOOL_NAME_SET.has(name);
}

// Default configuration values
export const DEFAULTS = {
  /** Default session TTL in milliseconds */
  SESSION_TTL_MS: TIME.DAY_MS,
  /** Default session TTL in seconds */
  SESSION_TTL_SECONDS: TIME.DAY_SECONDS,
  /** Default queue expiration in hours */
  QUEUE_EXPIRE_HOURS: 24,
  /** Default retry limit for queue operations */
  QUEUE_RETRY_LIMIT: 3,
  /** Default retry delay in seconds */
  QUEUE_RETRY_DELAY_SECONDS: TIME.THIRTY_SECONDS,
  /** Default session timeout in minutes */
  SESSION_TIMEOUT_MINUTES: 5,
} as const;
