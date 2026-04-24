/**
 * OAuth 2.0 Provider Configurations
 *
 * Centralizes OAuth provider settings for easy addition of new providers.
 * Each provider defines its endpoints, client credentials, and OAuth-specific settings.
 */

export interface OAuthProviderConfig {
  /** Unique provider identifier */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** OAuth 2.0 client ID (public identifier) */
  clientId: string;
  /** OAuth 2.0 client secret (optional - not used for public clients with PKCE) */
  clientSecret?: string;
  /** Authorization endpoint URL */
  authUrl: string;
  /** Token exchange endpoint URL */
  tokenUrl: string;
  /** OAuth redirect URI */
  redirectUri: string;
  /** OAuth scopes (space-separated) */
  scope: string;
  /** Use PKCE for public clients (RFC 7636) */
  usePKCE: boolean;
  /** Response type (default: "code") */
  responseType?: string;
  /** Grant type (default: "authorization_code") */
  grantType?: string;
  /** Custom headers to include in token requests */
  customHeaders?: Record<string, string>;
  /** Token endpoint auth method */
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_post"
    | "client_secret_basic";
  /** Whether auth-code exchange must include refresh_token */
  requireRefreshToken?: boolean;
}

/**
 * Claude OAuth Configuration
 *
 * Mirrors the public Claude Code CLI client so Anthropic's OAuth token endpoint
 * treats us as a first-party client. Deviating from this (partial scope,
 * browser-like headers, wrong authorize URL) causes `/v1/oauth/token` to
 * return 429 rate_limit_error on any failed code exchange.
 */
export const CLAUDE_PROVIDER: OAuthProviderConfig = {
  id: "claude",
  name: "Claude",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authUrl: "https://console.anthropic.com/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scope: "org:create_api_key user:profile user:inference",
  usePKCE: true,
  responseType: "code",
  grantType: "authorization_code",
  tokenEndpointAuthMethod: "none",
  requireRefreshToken: true,
};
