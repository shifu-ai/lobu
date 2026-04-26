import path from 'node:path';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'spa',
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/app',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    allowedHosts: true,
    hmr: process.env.VITE_HMR_HOST
      ? {
          host: process.env.VITE_HMR_HOST,
          clientPort: Number(process.env.VITE_HMR_CLIENT_PORT || 8443),
          protocol: process.env.VITE_HMR_PROTOCOL || 'wss',
        }
      : undefined,
  },
});
