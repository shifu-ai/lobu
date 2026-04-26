import type { ConnectorAuthMethod, ConnectorAuthSchema } from '@/lib/api';

export const EMPTY_VALUES: Record<string, unknown> = {};

export type OAuthMethod = Extract<ConnectorAuthMethod, { type: 'oauth' }>;
export type EnvKeysMethod = Extract<ConnectorAuthMethod, { type: 'env_keys' }>;
export type BrowserMethod = Extract<ConnectorAuthMethod, { type: 'browser' }>;
export const ADD_NEW_OAUTH_ACCOUNT_VALUE = '__add_new_oauth_account__';

type BrowserMethodWithCdp = BrowserMethod & {
  capture?: 'cli' | 'cdp';
  defaultCdpUrl?: string;
};

export function getOAuthCredentialKeys(method: OAuthMethod): {
  clientIdKey: string;
  clientSecretKey: string;
} {
  const providerUpper = method.provider.toUpperCase();
  return {
    clientIdKey: method.clientIdKey || `${providerUpper}_CLIENT_ID`,
    clientSecretKey: method.clientSecretKey || `${providerUpper}_CLIENT_SECRET`,
  };
}

export function castAuthSchema(
  raw?: Record<string, unknown> | null
): ConnectorAuthSchema | undefined {
  if (!raw) return undefined;
  return raw as unknown as ConnectorAuthSchema;
}

export function getAuthMethods(raw?: Record<string, unknown> | null): ConnectorAuthMethod[] {
  return castAuthSchema(raw)?.methods ?? [];
}

/** Get non-'none' auth methods that the user can pick from at connection time.
 *  Filters based on what's already configured at install time:
 *  - oauth: only shown if clientIdKey + clientSecretKey are in configuredKeys
 *  - env_keys: only fields NOT in configuredKeys are shown; hidden entirely if all configured
 */
export function getSelectableMethods(
  raw?: Record<string, unknown> | null,
  configuredKeys?: Set<string>
): ConnectorAuthMethod[] {
  const allMethods = getAuthMethods(raw);
  const hasOtherMethods = allMethods.some((m) => m.type !== 'none');
  return allMethods
    .filter((m) => m.type !== 'none' || hasOtherMethods)
    .filter((m) => {
      if (!configuredKeys || configuredKeys.size === 0) return true;
      if (m.type === 'oauth') {
        const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(m as OAuthMethod);
        // OAuth is available only if client ID + secret are configured
        return configuredKeys.has(clientIdKey) && configuredKeys.has(clientSecretKey);
      }
      if (m.type === 'env_keys') {
        // Show env_keys only if there are unconfigured fields remaining
        const remaining = m.fields.filter((f) => !configuredKeys.has(f.key));
        return remaining.length > 0;
      }
      return true;
    });
}

/** Short label for the primary auth method of a connector's auth_schema */
export function getAuthSchemaLabel(raw?: Record<string, unknown> | null): string | null {
  const methods = getAuthMethods(raw);
  if (!methods.length) return null;
  const hasOAuth = methods.some((m) => m.type === 'oauth');
  const hasEnv = methods.some((m) => m.type === 'env_keys');
  const hasBrowser = methods.some((m) => m.type === 'browser');
  if (hasOAuth) return 'OAuth';
  if (hasEnv) return 'API Key';
  if (hasBrowser) return 'Browser';
  return null;
}

/** Short label for a method in the selector */
export function getRequiredOAuthScopes(method?: OAuthMethod | null): string[] {
  return Array.isArray(method?.requiredScopes)
    ? method.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

export function getOptionalOAuthScopes(method?: OAuthMethod | null): string[] {
  return Array.isArray(method?.optionalScopes)
    ? method.optionalScopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

export function buildRequestedOAuthScopes(
  method?: OAuthMethod | null,
  selectedOptionalScopes?: string[] | null
): string[] {
  const requiredScopes = getRequiredOAuthScopes(method);
  const optionalScopeSet = new Set(getOptionalOAuthScopes(method));
  const requestedOptionalScopes = (selectedOptionalScopes ?? []).filter((scope) =>
    optionalScopeSet.has(scope)
  );
  return Array.from(new Set([...requiredScopes, ...requestedOptionalScopes]));
}

export function getMethodLabel(method: ConnectorAuthMethod): string {
  if (method.type === 'oauth') {
    const provider = method.provider.charAt(0).toUpperCase() + method.provider.slice(1);
    return `OAuth (${provider})`;
  }
  if (method.type === 'env_keys') {
    return 'API Key / Token';
  }
  if (method.type === 'browser') {
    return 'Browser';
  }
  if (method.type === 'none') {
    return 'No Authentication';
  }
  if (method.type === 'interactive') {
    return 'Interactive pairing';
  }
  return (method as { type: string }).type;
}

export function isCdpBrowserMethod(
  method?: ConnectorAuthMethod | null
): method is BrowserMethodWithCdp {
  return method?.type === 'browser' && method.capture === 'cdp';
}

export function getBrowserMethodDefaultCdpUrl(method?: ConnectorAuthMethod | null): string {
  if (!isCdpBrowserMethod(method)) return 'auto';
  return method.defaultCdpUrl ?? 'auto';
}

/** Build a JSON Schema from env_keys fields so DynamicConnectorForm can render them.
 *  Excludes keys already configured at install time and oauth app keys. */
export function buildEnvKeysSchema(
  method: EnvKeysMethod,
  excludeKeys?: Set<string>
): Record<string, unknown> | undefined {
  const fields = excludeKeys ? method.fields.filter((f) => !excludeKeys.has(f.key)) : method.fields;
  if (fields.length === 0) return undefined;

  const properties = Object.fromEntries(
    fields.map((f) => [
      f.key,
      {
        type: 'string',
        title: f.label || f.key,
        description: f.description,
        example: f.example,
        ...(f.secret ? { format: 'password' } : {}),
      },
    ])
  );
  const required = fields.filter((f) => f.required !== false).map((f) => f.key);

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ============================================================
// Registry install auth helpers
// ============================================================

type InstallAuthField = {
  key: string;
  label?: string;
  description?: string;
  example?: string;
  secret?: boolean;
  required: boolean;
};

function getInstallMethodFields(method: ConnectorAuthMethod): InstallAuthField[] {
  if (method.type === 'env_keys') {
    const methodRequired = method.required !== false;
    return method.fields.map((field) => ({
      key: field.key,
      label: field.label,
      description: field.description,
      example: field.example,
      secret: field.secret,
      required: methodRequired && field.required !== false,
    }));
  }

  if (method.type === 'oauth') {
    const methodRequired = method.required !== false;
    const providerLabel = method.provider
      ? method.provider.charAt(0).toUpperCase() + method.provider.slice(1)
      : 'OAuth';
    const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(method);

    return [
      {
        key: clientIdKey,
        label: `${providerLabel} Client ID`,
        description: `${providerLabel} OAuth client ID`,
        secret: false,
        required: methodRequired,
      },
      {
        key: clientSecretKey,
        label: `${providerLabel} Client Secret`,
        description: `${providerLabel} OAuth client secret`,
        secret: true,
        required: methodRequired,
      },
    ];
  }

  return [];
}

export function getInstallSelectableMethods(
  authSchema?: Record<string, unknown> | null
): ConnectorAuthMethod[] {
  return getSelectableMethods(authSchema);
}

export function buildInstallAuthSchemaForMethod(
  method?: ConnectorAuthMethod | null
): Record<string, unknown> | undefined {
  if (!method || method.type === 'none') return undefined;
  const fields = getInstallMethodFields(method);
  if (fields.length === 0) return undefined;

  const properties = Object.fromEntries(
    fields.map((field) => [
      field.key,
      {
        type: 'string',
        title: field.required ? field.label || field.key : `${field.label || field.key} (Optional)`,
        description: field.description,
        example: field.example,
        ...(field.secret ? { format: 'password' } : {}),
      },
    ])
  );
  const required = fields.filter((f) => f.required).map((f) => f.key);

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function getRequiredInstallKeysForMethod(method?: ConnectorAuthMethod | null): string[] {
  if (!method || method.type === 'none') return [];

  return getInstallMethodFields(method)
    .filter((f) => f.required)
    .map((f) => f.key);
}
