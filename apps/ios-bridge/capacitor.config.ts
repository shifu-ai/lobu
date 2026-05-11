import type { CapacitorConfig } from "@capacitor/cli";

declare const process: { env: Record<string, string | undefined> };

const config: CapacitorConfig = {
  appId: "ai.lobu.IOSBridge",
  appName: "Lobu",
  webDir: "www",
  // Load the live Lobu web app over HTTPS. Cookies + localStorage persist in
  // WKWebView automatically so users sign in once.
  server: {
    url: process.env.LOBU_WEB_URL ?? "https://app.lobu.ai",
    cleartext: false,
  },
  ios: {
    contentInset: "always",
  },
};

export default config;
