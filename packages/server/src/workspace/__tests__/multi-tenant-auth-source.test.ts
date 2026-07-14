/**
 * Pin the `authSource` contract on `MultiTenantProvider.resolveAuth`.
 *
 * `c.var.authSource` lets admin-tier routes (see
 * `requireSessionOrAdminPat` in `lobu/agent-routes.ts`) distinguish how a
 * caller authenticated. The full middleware exercises better-auth, the OAuth
 * provider, and the PAT service — all of which need a live DB. To avoid
 * duplicating the test-workspace bootstrap, this file pins the contract via
 * the source: every code path that calls `setContextAndContinue` MUST pass
 * an `authSource` literal that matches the branch's auth flavor.
 *
 * If the source is restructured so this regex match no longer makes sense
 * (e.g. the context plumbing moves into a different file), update both this
 * test AND the moved code together.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(
  new URL('../multi-tenant.ts', import.meta.url),
  'utf8'
);

const PAT_OAUTH_ASSIGNMENT =
  /authSource\s*:\s*isPat\s*\?\s*["']pat["']\s*:\s*["']oauth["']\s*,/g;
const SESSION_ASSIGNMENT = /authSource\s*:\s*["']session["']\s*,/g;
const DIRECT_PAT_ASSIGNMENT = /authSource\s*:\s*["']pat["']\s*,/g;

function assignmentCount(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function removeFirstAssignment(source: string, pattern: RegExp): string {
  return source.replace(new RegExp(pattern.source), '');
}

describe('multi-tenant resolveAuth: authSource per branch', () => {
  it('pins both PAT/OAuth object assignments and the worker direct-PAT assignment', () => {
    // The PAT and OAuth bearer flow has two successful exits: unscoped and
    // organization-scoped. Worker direct auth has one separate PAT exit.
    expect(assignmentCount(SOURCE, PAT_OAUTH_ASSIGNMENT)).toBe(2);
    expect(assignmentCount(SOURCE, DIRECT_PAT_ASSIGNMENT)).toBe(1);
  });

  it('pins all three session-cookie object assignments', () => {
    // Three session-cookie paths: unscoped /mcp, member, and non-member
    // public-readable fallthrough. The trailing comma requirement excludes
    // the helper's type union from this count.
    expect(assignmentCount(SOURCE, SESSION_ASSIGNMENT)).toBe(3);
  });

  it('detects a removed real branch assignment instead of counting the helper union', () => {
    const withoutOneSessionBranch = removeFirstAssignment(SOURCE, SESSION_ASSIGNMENT);
    const withoutOnePatOAuthBranch = removeFirstAssignment(
      SOURCE,
      PAT_OAUTH_ASSIGNMENT,
    );

    expect(assignmentCount(withoutOneSessionBranch, SESSION_ASSIGNMENT)).toBe(2);
    expect(assignmentCount(withoutOnePatOAuthBranch, PAT_OAUTH_ASSIGNMENT)).toBe(1);
  });

  it("initializes c.var.authSource to null at the top of resolveAuth", () => {
    expect(SOURCE).toMatch(
      /c\s*\.\s*set\s*\(\s*["']authSource["']\s*,\s*null\s*\)/,
    );
  });

  it('setContextAndContinue threads authSource through', () => {
    // Defensive — if someone refactors the helper signature, the per-branch
    // sets above won't actually be applied. Assert the helper accepts and
    // applies the override.
    expect(SOURCE).toMatch(
      /authSource\s*:\s*["']session["']\s*\|\s*["']pat["']\s*\|\s*["']oauth["']\s*\|\s*null\s*;/,
    );
    expect(SOURCE).toMatch(
      /if\s*\(\s*overrides\.authSource\s*!==\s*undefined\s*\)\s*c\s*\.\s*set\s*\(\s*["']authSource["']\s*,\s*overrides\.authSource\s*\)\s*;/,
    );
  });
});
