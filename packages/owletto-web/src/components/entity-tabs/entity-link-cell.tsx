import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { buildEntityTabUrl, type EntityReference, type EntityTabName } from './types';

interface EntityLinkCellProps {
  ownerSlug: string;
  entity: EntityReference;
  tab: EntityTabName;
  className?: string;
}

/**
 * Reusable component for displaying entity name with drill-down link
 * Used in org-wide mode tables to navigate to the entity's specific tab
 */
export function EntityLinkCell({ ownerSlug, entity, tab, className }: EntityLinkCellProps) {
  const url = buildEntityTabUrl(ownerSlug, entity, tab);

  return (
    <Link
      to={url}
      className={`flex items-center gap-1 text-primary hover:underline group ${className ?? ''}`}
    >
      <span className="font-medium">{entity.entityName}</span>
      <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}
