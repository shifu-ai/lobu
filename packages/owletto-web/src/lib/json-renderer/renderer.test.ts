import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JsonRenderer } from './renderer';
import type { JsonNode } from './types';

function render(root: JsonNode, data: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(JsonRenderer, { template: { root }, data }));
}

describe('TemplateRenderer', () => {
  describe('progress component', () => {
    it('renders progress bar with percentage label', () => {
      const html = render({ type: 'progress', props: { value: 75 } } as JsonNode, {});
      expect(html).toContain('75%');
      // Should have the bar element
      expect(html).toContain('bg-primary');
    });

    it('renders progress bar with custom label', () => {
      const html = render(
        { type: 'progress', props: { value: 80, label: '80/100' } } as JsonNode,
        {}
      );
      expect(html).toContain('80/100');
    });

    it('resolves data binding for progress value', () => {
      const html = render({ type: 'progress', value: '{{score}}' } as unknown as JsonNode, {
        score: 60,
      });
      expect(html).toContain('60%');
    });
  });

  describe('markdown component', () => {
    it('renders markdown content with headings and lists', () => {
      const html = render({ type: 'markdown', content: '{{analysis}}' } as unknown as JsonNode, {
        analysis: '## Risks\n- Item one\n- Item two',
      });
      // h2 in markdown maps to h3 element in our components
      expect(html).toContain('<h3');
      expect(html).toContain('Risks');
      expect(html).toContain('<li');
      expect(html).toContain('Item one');
    });

    it('renders links with target _blank', () => {
      const html = render({ type: 'markdown', content: '{{text}}' } as unknown as JsonNode, {
        text: 'Visit [example](https://example.com)',
      });
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain('target="_blank"');
    });
  });

  describe('badge humanization in data tables', () => {
    it('humanizes badge field values in tables', () => {
      const html = render(
        {
          type: 'table',
          data: '{{rows}}',
          columns: '{{cols}}',
        } as unknown as JsonNode,
        {
          rows: [{ name: 'Test', severity: 'very_high' }],
          cols: ['name', 'severity'],
        }
      );
      expect(html).toContain('Very High');
      expect(html).not.toContain('very_high');
    });
  });
});
