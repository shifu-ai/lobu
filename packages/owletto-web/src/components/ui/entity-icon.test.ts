import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntityIcon } from './entity-icon';

describe('EntityIcon', () => {
  it('renders the matching Lucide icon for valid kebab-case names', () => {
    const html = renderToStaticMarkup(
      createElement(EntityIcon, { icon: 'chart-column', className: 'h-4 w-4' })
    );

    expect(html).toContain('<svg');
  });

  it('falls back to the default icon for unknown Lucide-style names', () => {
    const html = renderToStaticMarkup(
      createElement(EntityIcon, { icon: 'bar-chart', className: 'h-4 w-4' })
    );

    expect(html).toContain('<svg');
    expect(html).not.toContain('bar-chart');
  });

  it('preserves emoji values as text', () => {
    const html = renderToStaticMarkup(createElement(EntityIcon, { icon: '📦' }));

    expect(html).toContain('📦');
  });

  it('uses the caller fallback when no icon value is provided', () => {
    const html = renderToStaticMarkup(createElement(EntityIcon, { fallback: 'OW' }));

    expect(html).toContain('OW');
    expect(html).not.toContain('<svg');
  });

  it('renders the default icon when there is no icon and no explicit fallback', () => {
    const html = renderToStaticMarkup(createElement(EntityIcon, {}));

    expect(html).toContain('<svg');
  });
});
