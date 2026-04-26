import { icons as lucideIcons } from 'lucide-react';

const DEFAULT_ENTITY_ICON = lucideIcons.Shapes;
const LUCIDE_ICON_NAME_PATTERN = /^[a-z0-9]+(?:[-_ ][a-z0-9]+)*$/i;
const LUCIDE_PASCAL_CASE_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

function resolveLucideIcon(icon: string) {
  const trimmed = icon.trim();
  if (!trimmed) return null;

  const exactMatch = lucideIcons[trimmed as keyof typeof lucideIcons];
  if (exactMatch) return exactMatch;

  const normalizedName = trimmed
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');

  if (!normalizedName) return null;

  return lucideIcons[normalizedName as keyof typeof lucideIcons] ?? null;
}

function looksLikeLucideIconName(icon: string) {
  const trimmed = icon.trim();
  return LUCIDE_ICON_NAME_PATTERN.test(trimmed) || LUCIDE_PASCAL_CASE_PATTERN.test(trimmed);
}

/**
 * Resolve an entity-type icon value to a renderable element.
 * Handles Lucide icon names (e.g. "briefcase", "arrow-right") and emoji strings.
 */
export function EntityIcon({
  icon,
  className = 'h-4 w-4',
  fallback,
}: {
  icon?: string | null;
  className?: string;
  fallback?: string;
}) {
  if (!icon) {
    return fallback ? <span>{fallback}</span> : <DEFAULT_ENTITY_ICON className={className} />;
  }

  const LucideIcon = resolveLucideIcon(icon);
  if (LucideIcon) {
    return <LucideIcon className={className} />;
  }

  if (looksLikeLucideIconName(icon)) {
    return <DEFAULT_ENTITY_ICON className={className} />;
  }

  // Non-Lucide-style values are treated as emoji / text labels on purpose.
  return <span>{icon}</span>;
}
