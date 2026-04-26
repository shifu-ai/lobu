/// <reference types="vite/client" />

import type { PublicPageBootstrap } from './lib/public-bootstrap';

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    __OWLETTO_PUBLIC_BOOTSTRAP__?: PublicPageBootstrap;
  }
}
