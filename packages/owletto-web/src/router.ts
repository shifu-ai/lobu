import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { parseRouterSearch, stringifyRouterSearch } from './lib/router-search';
import { getSubdomainOwner } from './lib/subdomain';
import { createSubdomainHistory } from './lib/subdomain-history';
import { routeTree } from './routeTree.gen';

// Shared QueryClient + router instance. Exported so non-route code
// (e.g. `components/providers.tsx`, which sits above <RouterProvider>)
// can call `router.navigate(...)` without hooks.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

const subdomainOwner = getSubdomainOwner();

export const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  history: subdomainOwner ? createSubdomainHistory(subdomainOwner) : undefined,
  parseSearch: parseRouterSearch,
  stringifySearch: stringifyRouterSearch,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
