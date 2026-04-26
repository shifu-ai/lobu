import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JsonRenderer } from './json-renderer';

function render(data: unknown) {
  return renderToStaticMarkup(createElement(JsonRenderer, { data }));
}

describe('JsonRenderer', () => {
  describe('humanizeValue — badge enum values', () => {
    it('humanizes snake_case sentiment in badge fields', () => {
      // An object with a "sentiment" field should render as a humanized badge
      const html = render({
        items: [{ name: 'Test', sentiment: 'very_positive' }],
      });
      expect(html).toContain('Very Positive');
      expect(html).not.toContain('very_positive');
    });

    it('humanizes category badges in item cards', () => {
      const html = render({
        items: [{ name: 'Bug', category: 'high_priority' }],
      });
      expect(html).toContain('High Priority');
      expect(html).not.toContain('high_priority');
    });

    it('humanizes severity badges in item cards', () => {
      const html = render({
        items: [{ name: 'Issue', severity: 'very_high' }],
      });
      expect(html).toContain('Very High');
      expect(html).not.toContain('very_high');
    });
  });

  describe('isLongStringArray — bullet list rendering', () => {
    it('renders long string arrays as bullet lists', () => {
      const html = render({
        risks: [
          'Early month data only - full month picture incomplete',
          'High content volume may indicate crawler catching up with historical data',
          'Market conditions could change significantly before month end',
        ],
      });
      expect(html).toContain('<ul');
      expect(html).toContain('<li');
      expect(html).toContain('Early month data only');
    });

    it('renders short string arrays as badges', () => {
      const html = render({
        tags: ['bug', 'ui', 'critical'],
      });
      // Short strings → badges (no <ul>)
      expect(html).not.toContain('<ul');
      expect(html).toContain('bug');
      expect(html).toContain('ui');
      expect(html).toContain('critical');
    });
  });

  describe('isMarkdownLike — markdown rendering', () => {
    it('renders multi-line long text as markdown', () => {
      const longText =
        '## Key Events\n- Runway Characters powered by Modal real-time inference\n- RTX Pro 6000 Blackwell GPU availability\n\n## Risks\n- Early month data only\n- High content volume may indicate catching up';
      const html = render({ analysis: longText });
      // h2 in markdown maps to h3 element in our components
      expect(html).toContain('<h3');
      expect(html).toContain('Key Events');
      expect(html).toContain('<li');
    });

    it('does not render short single-line strings as markdown', () => {
      const html = render({ name: 'Modal' });
      // Short string → plain span, no prose wrapper
      expect(html).not.toContain('<h2');
      expect(html).toContain('Modal');
    });
  });

  describe('primitive rendering', () => {
    it('renders URLs as links', () => {
      const html = render({ url: 'https://example.com' });
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain('target="_blank"');
    });

    it('renders booleans as Yes/No badges', () => {
      const html = render({ active: true });
      expect(html).toContain('Yes');
    });

    it('renders numbers with formatting', () => {
      const html = render({ count: 1234 });
      expect(html).toContain('1,234');
    });
  });
});
