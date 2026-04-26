import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProviders } from './components/providers';
import { queryClient, router } from './router';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProviders>
        <RouterProvider router={router} />
      </AuthProviders>
    </QueryClientProvider>
  </React.StrictMode>
);

// If the server pre-rendered a public page into #ssr-hydrate-shell, fade it out
// once the SPA has produced its first paint. Two RAFs defer past createRoot's
// initial commit so the user doesn't see a bare background between the two.
const ssrShell = document.getElementById('ssr-hydrate-shell');
if (ssrShell) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ssrShell.classList.add('is-hidden');
      const cleanup = () => ssrShell.remove();
      ssrShell.addEventListener('transitionend', cleanup, { once: true });
      // Fallback in case transitionend never fires (e.g. prefers-reduced-motion).
      window.setTimeout(cleanup, 400);
    });
  });
}
