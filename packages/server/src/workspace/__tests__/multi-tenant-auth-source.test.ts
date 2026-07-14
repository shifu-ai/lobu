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

describe('multi-tenant resolveAuth: authSource per branch', () => {
  it('PAT/OAuth branch picks pat or oauth via isPat ternary', () => {
    // The PAT and OAuth bearers share a code path; the branch picks the
    // label off the same `isPat` boolean it already used to dispatch
    // verification.
    expect(SOURCE).toMatch(
      /authSource\s*:\s*isPat\s*\?\s*["']pat["']\s*:\s*["']oauth["']/,
    );
  });

  it('session-cookie branch sets authSource: session', () => {
    // Three session-cookie paths: unscoped /mcp, member, and non-member
    // public-readable fallthrough. All three must label the source.
    const matches = SOURCE.match(/authSource\s*:\s*["']session["']/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
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
