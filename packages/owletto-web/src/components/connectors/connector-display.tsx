import { useState } from 'react';
import { EntityIcon } from '@/components/ui/entity-icon';
import { cn } from '@/lib/utils';

export interface ConnectorDisplayData {
  key: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  faviconDomain?: string | null;
}

export interface ConnectorDefinitionLike {
  key: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  favicon_domain?: string | null;
  auth_schema?: Record<string, unknown> | null;
}

export function buildConnectorDefinitionMap<T extends ConnectorDefinitionLike>(definitions: T[]) {
  return new Map(definitions.map((definition) => [definition.key, definition]));
}

/**
 * Extract the first OAuth provider domain from a connector's auth_schema.
 * Uses the authorizationUrl or provider name to derive a domain for favicon lookup.
 */
export function extractOAuthDomain(
  authSchema: Record<string, unknown> | null | undefined
): string | null {
  if (!authSchema) return null;
  const methods = (authSchema as { methods?: Array<Record<string, unknown>> }).methods;
  if (!Array.isArray(methods)) return null;

  for (const method of methods) {
    if (method.type !== 'oauth') continue;

    // If the method has an explicit authorization URL, extract domain from it
    const authUrl = method.authorization_url ?? method.authorizationUrl;
    if (typeof authUrl === 'string') {
      try {
        return new URL(authUrl).hostname;
      } catch {
        // not a valid URL
      }
    }

    // Fall back to provider name as domain (e.g. "reddit" → "reddit.com")
    if (typeof method.provider === 'string' && method.provider.length > 0) {
      return `${method.provider}.com`;
    }
  }

  return null;
}

export function resolveConnectorDisplay(
  connectorKey: string,
  definitions: Map<string, ConnectorDefinitionLike> | ConnectorDefinitionLike[],
  fallback?: Partial<ConnectorDisplayData>
): ConnectorDisplayData {
  const definitionMap = Array.isArray(definitions)
    ? buildConnectorDefinitionMap(definitions)
    : definitions;
  const definition = definitionMap.get(connectorKey);

  return {
    key: connectorKey,
    name: definition?.name || fallback?.name || connectorKey,
    description: definition?.description ?? fallback?.description ?? null,
    icon: definition?.icon ?? fallback?.icon ?? null,
    faviconDomain:
      definition?.favicon_domain ?? extractOAuthDomain(definition?.auth_schema) ?? null,
  };
}

function getConnectorMonogram(name: string): string {
  const compact = name.trim();
  if (!compact) return '?';

  // Strip non-alphanumeric characters, then split into words
  const cleaned = compact.replace(/[^a-zA-Z0-9\s.-]/g, '').trim();
  const words = cleaned.split(/[\s.-]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  }

  return (cleaned || compact).slice(0, 2).toUpperCase();
}

export function ConnectorMark({
  icon,
  name,
  faviconDomain,
  className,
}: {
  icon?: string | null;
  name: string;
  faviconDomain?: string | null;
  className?: string;
}) {
  const [faviconError, setFaviconError] = useState(false);

  if (icon) {
    return (
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground',
          className
        )}
      >
        <EntityIcon icon={icon} className="h-4 w-4" fallback={getConnectorMonogram(name)} />
      </span>
    );
  }

  if (faviconDomain && !faviconError) {
    return (
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground',
          className
        )}
      >
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(faviconDomain)}&sz=32`}
          alt={name}
          width={16}
          height={16}
          className="h-4 w-4"
          onError={() => setFaviconError(true)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
        className
      )}
    >
      {getConnectorMonogram(name)}
    </span>
  );
}

export function ConnectorDisplay({
  connector,
  className,
  nameClassName,
  descriptionClassName,
  showDescription = true,
}: {
  connector: ConnectorDisplayData & { auth_schema?: Record<string, unknown> | null };
  className?: string;
  nameClassName?: string;
  descriptionClassName?: string;
  showDescription?: boolean;
}) {
  const faviconDomain = connector.faviconDomain ?? extractOAuthDomain(connector.auth_schema);
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      <ConnectorMark icon={connector.icon} name={connector.name} faviconDomain={faviconDomain} />
      <div className="min-w-0">
        <div className={cn('truncate text-sm font-medium', nameClassName)}>{connector.name}</div>
        {showDescription && connector.description && (
          <p className={cn('truncate text-xs text-muted-foreground', descriptionClassName)}>
            {connector.description}
          </p>
        )}
      </div>
    </div>
  );
}
