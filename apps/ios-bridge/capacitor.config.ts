import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.lobu.IOSBridge",
  appName: "Lobu",
  webDir: "www",
  // Load the live Lobu web app over HTTPS. Cookies + localStorage persist in
  // WKWebView automatically so users sign in once. Swap this URL for prod
  // before shipping (or wire a build-time env var).
  server: {
    url: "https://buraks-macbook-pro-1.brill-kanyu.ts.net:8443",
    cleartext: false,
  },
  ios: {
    contentInset: "always",
  },
};

export default config;
