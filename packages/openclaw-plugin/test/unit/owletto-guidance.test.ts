/**
 * Unit tests for the pure rendering helpers in owletto-guidance.ts.
 * These functions are template-rendered strings — no I/O, no side effects.
 */

import { describe, expect, it } from 'bun:test';
import {
  renderFallbackSystemContext,
  renderSkillMemorySection,
} from '../../src/owletto-guidance.js';

const STANDALONE_SAVE_TOOL = 'owletto_save_knowledge';
const STANDALONE_SEARCH_TOOL = 'owletto_search_knowledge';
const GATEWAY_SAVE_TOOL = 'save_knowledge';
const GATEWAY_SEARCH_TOOL = 'search_knowledge';

describe('renderFallbackSystemContext', () => {
  it('wraps the output in <owletto-system> tags and includes the Memory header', () => {
    const out = renderFallbackSystemContext();
    expect(out.startsWith('<owletto-system>')).toBe(true);
    expect(out.endsWith('</owletto-system>')).toBe(true);
    expect(out).toContain('## Memory');
  });

  it('contains the standalone-mode tool names by default', () => {
    const out = renderFallbackSystemContext();
    expect(out).toContain(STANDALONE_SAVE_TOOL);
    expect(out).toContain(STANDALONE_SEARCH_TOOL);
    expect(out).not.toMatch(/\bsave_knowledge\b(?!_)/); // no bare save_knowledge
    expect(out).not.toMatch(/\bsearch_knowledge\b(?!_)/);
  });

  it('treats undefined options the same as standalone mode', () => {
    expect(renderFallbackSystemContext()).toBe(
      renderFallbackSystemContext({ gatewayMode: false })
    );
  });

  it('uses gateway-mode tool names when gatewayMode is true', () => {
    const out = renderFallbackSystemContext({ gatewayMode: true });
    expect(out).toContain(GATEWAY_SAVE_TOOL);
    expect(out).toContain(GATEWAY_SEARCH_TOOL);
    expect(out).not.toContain(STANDALONE_SAVE_TOOL);
    expect(out).not.toContain(STANDALONE_SEARCH_TOOL);
  });

  it('appends the auth-recovery hint only in gateway mode', () => {
    const gateway = renderFallbackSystemContext({ gatewayMode: true });
    const standalone = renderFallbackSystemContext({ gatewayMode: false });
    expect(gateway).toContain('owletto_login');
    expect(gateway).toContain('owletto_login_check');
    expect(standalone).not.toContain('owletto_login');
    expect(standalone).not.toContain('owletto_login_check');
  });

  it('renders the do-not-construct-URLs guidance line', () => {
    const out = renderFallbackSystemContext();
    expect(out).toContain('NEVER construct Owletto URLs yourself');
  });

  it('mentions the local-files prohibition', () => {
    expect(renderFallbackSystemContext()).toContain('Do NOT use local files');
  });

  it('emits each rule template once per rendering', () => {
    const out = renderFallbackSystemContext();
    // The "automatic recall" rule appears once per render.
    const matches = out.match(/automatically recalls relevant memories/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('renders rules as a markdown bullet list', () => {
    const out = renderFallbackSystemContext();
    // Five rule templates → at least five "- " bullet lines.
    const bullets = out.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
  });

  it('treats explicit gatewayMode: false as standalone', () => {
    const out = renderFallbackSystemContext({ gatewayMode: false });
    expect(out).toContain(STANDALONE_SAVE_TOOL);
  });
});

describe('renderSkillMemorySection', () => {
  it('starts with the Memory Defaults heading', () => {
    expect(renderSkillMemorySection().startsWith('## Memory Defaults')).toBe(true);
  });

  it('always uses the gateway-mode tool names', () => {
    const out = renderSkillMemorySection();
    expect(out).toContain(GATEWAY_SAVE_TOOL);
    expect(out).toContain(GATEWAY_SEARCH_TOOL);
    expect(out).not.toContain(STANDALONE_SAVE_TOOL);
    expect(out).not.toContain(STANDALONE_SEARCH_TOOL);
  });

  it('includes the do-not-use-local-files intro', () => {
    expect(renderSkillMemorySection()).toContain('Do NOT use local files');
  });

  it('does not wrap output in <owletto-system> tags (skill section is standalone markdown)', () => {
    const out = renderSkillMemorySection();
    expect(out).not.toContain('<owletto-system>');
    expect(out).not.toContain('</owletto-system>');
  });

  it('omits the gateway auth-recovery hint (skill mode does not call owletto_login)', () => {
    expect(renderSkillMemorySection()).not.toContain('owletto_login');
  });

  it('renders all five rule templates as bullets', () => {
    const out = renderSkillMemorySection();
    const bullets = out.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBe(5);
  });

  it('produces deterministic output across calls', () => {
    expect(renderSkillMemorySection()).toBe(renderSkillMemorySection());
  });
});
