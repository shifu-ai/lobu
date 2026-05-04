import { describe, expect, it } from 'bun:test';
import {
  renderFallbackSystemContext,
  renderSkillMemorySection,
} from '../../src/owletto-guidance.js';

const RULE_BULLET_COUNT = 5; // mirrors MEMORY_RULE_TEMPLATES.length in source

describe('renderFallbackSystemContext', () => {
  it('produces a complete <owletto-system> block in standalone mode (default)', () => {
    const out = renderFallbackSystemContext();
    expect(out.startsWith('<owletto-system>')).toBe(true);
    expect(out.endsWith('</owletto-system>')).toBe(true);
    expect(out).toContain('## Memory');
    expect(out).toContain('Do NOT use local files');
    expect(out).toContain('NEVER construct Owletto URLs yourself');
    // Standalone tool names are exposed; the bare gateway names are not.
    expect(out).toContain('owletto_save_knowledge');
    expect(out).toContain('owletto_search_knowledge');
    expect(out).not.toMatch(/\bsave_knowledge\b(?!_)/);
    expect(out).not.toMatch(/\bsearch_knowledge\b(?!_)/);
    // Standalone has no auth-recovery hint.
    expect(out).not.toContain('owletto_login');
    // All rule templates render exactly once as bullets.
    const bullets = out.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBe(RULE_BULLET_COUNT);
  });

  it('switches to gateway tool names AND appends the auth-recovery hint when gatewayMode=true', () => {
    const out = renderFallbackSystemContext({ gatewayMode: true });
    expect(out).toContain('save_knowledge');
    expect(out).toContain('search_knowledge');
    expect(out).not.toContain('owletto_save_knowledge');
    expect(out).not.toContain('owletto_search_knowledge');
    // Gateway-only auth-recovery hint.
    expect(out).toContain('owletto_login');
    expect(out).toContain('owletto_login_check');
    // Hint adds an extra bullet beyond the 5 rule templates.
    const bullets = out.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBe(RULE_BULLET_COUNT + 1);
  });

  it('treats undefined and gatewayMode=false identically', () => {
    expect(renderFallbackSystemContext()).toBe(
      renderFallbackSystemContext({ gatewayMode: false })
    );
  });
});

describe('renderSkillMemorySection', () => {
  it('uses the gateway tool names, omits the <owletto-system> wrapper, and skips the auth hint', () => {
    const out = renderSkillMemorySection();
    expect(out.startsWith('## Memory Defaults')).toBe(true);
    expect(out).toContain('Do NOT use local files');
    expect(out).toContain('save_knowledge');
    expect(out).toContain('search_knowledge');
    expect(out).not.toContain('owletto_save_knowledge');
    expect(out).not.toContain('owletto_search_knowledge');
    expect(out).not.toContain('<owletto-system>');
    expect(out).not.toContain('owletto_login');
    const bullets = out.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBe(RULE_BULLET_COUNT);
  });
});
