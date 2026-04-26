import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { EntityIcon } from '@/components/ui/entity-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type Organization as ApiOrganization, useEntityTypes, useOrganizations } from '@/lib/api';
import { organization } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';
import { titleCaseWords } from '@/lib/string-utils';
import { buildOwnerHref } from '@/lib/subdomain';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Generic base
// ---------------------------------------------------------------------------

interface BreadcrumbItem {
  id: string;
  label: string;
  slug: string;
  icon?: string | null;
  badge?: number | null;
}

interface BreadcrumbSelectorProps {
  items: BreadcrumbItem[];
  activeId: string | null;
  onSelect: (item: BreadcrumbItem) => void;
  placeholder?: string;
  label: string;
  renderIcon?: (item: BreadcrumbItem) => React.ReactNode;
}

function BreadcrumbSelector({
  items,
  activeId,
  onSelect,
  placeholder = 'Search...',
  label,
  renderIcon,
}: BreadcrumbSelectorProps) {
  const [open, setOpen] = useState(false);

  if (items.length === 0) {
    return <span className="text-muted-foreground">{label}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto px-1 py-0 text-sm font-normal text-muted-foreground hover:text-foreground hover:bg-transparent"
        >
          {label}
          <ChevronsUpDown className="ml-1 h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <Command>
          <CommandInput placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.label}
                  onSelect={() => {
                    onSelect(item);
                    setOpen(false);
                  }}
                  className="cursor-pointer"
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4 flex-shrink-0',
                      item.id === activeId ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {renderIcon?.(item)}
                    <span className="truncate flex-1">{item.label}</span>
                    {item.badge != null && item.badge > 0 && (
                      <span className="text-xs text-muted-foreground ml-auto flex-shrink-0 px-1.5 py-0.5 bg-muted rounded">
                        {item.badge}
                      </span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Workspace selector
// ---------------------------------------------------------------------------

interface WorkspaceBreadcrumbSelectorProps {
  currentSlug: string;
  currentName: string;
}

export function WorkspaceBreadcrumbSelector({
  currentSlug,
  currentName,
}: WorkspaceBreadcrumbSelectorProps) {
  const navigate = useNavigate();
  const { session } = useAuthState();
  const { data: orgs } = useOrganizations();

  const items: BreadcrumbItem[] = (orgs ?? []).map((org: ApiOrganization) => ({
    id: org.id,
    label: org.name || org.slug,
    slug: org.slug,
    icon: org.logo,
  }));

  // If the current workspace isn't in the list yet (still loading), show it as plain text
  const activeItem = items.find((i) => i.slug === currentSlug);
  const activeId = activeItem?.id ?? null;

  const handleSelect = async (item: BreadcrumbItem) => {
    const matchedOrg = (orgs ?? []).find((o) => o.id === item.id);
    if (session && matchedOrg?.is_member) {
      await organization.setActive({ organizationId: item.id });
    }
    const target = buildOwnerHref(item.slug);
    if (target.kind === 'cross-host') {
      window.location.assign(target.href);
      return;
    }
    navigate({ to: target.to as '/' });
  };

  const renderIcon = (item: BreadcrumbItem) => {
    if (item.icon) {
      return (
        <img src={item.icon} alt="" className="h-4 w-4 rounded-sm object-cover flex-shrink-0" />
      );
    }
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-muted text-[10px] font-medium flex-shrink-0">
        {item.label.charAt(0).toUpperCase()}
      </span>
    );
  };

  return (
    <BreadcrumbSelector
      items={items}
      activeId={activeId}
      onSelect={handleSelect}
      placeholder="Search organizations..."
      label={currentName}
      renderIcon={renderIcon}
    />
  );
}

// ---------------------------------------------------------------------------
// Entity type selector
// ---------------------------------------------------------------------------

const HIDDEN_ENTITY_SLUGS = new Set([
  'organization',
  'user',
  '$member',
  'watcher',
  'watchers',
  'content',
  'source',
  'sources',
]);

interface EntityTypeBreadcrumbSelectorProps {
  ownerSlug: string;
  currentEntityTypeSlug: string;
  currentLabel: string;
  orgContext: { slug?: string };
}

export function EntityTypeBreadcrumbSelector({
  ownerSlug,
  currentEntityTypeSlug,
  currentLabel,
  orgContext,
}: EntityTypeBreadcrumbSelectorProps) {
  const navigate = useNavigate();
  const { data: entityTypes } = useEntityTypes(orgContext);

  const visibleTypes = (entityTypes ?? []).filter((et) => !HIDDEN_ENTITY_SLUGS.has(et.slug));

  const items: BreadcrumbItem[] = visibleTypes.map((et) => ({
    id: String(et.id),
    label: et.name?.trim() || titleCaseWords(et.slug),
    slug: et.slug,
    icon: et.icon,
    badge: et.entity_count ?? null,
  }));

  const activeItem = items.find((i) => i.slug === currentEntityTypeSlug);
  const activeId = activeItem?.id ?? null;

  const handleSelect = (item: BreadcrumbItem) => {
    navigate({ to: `/${ownerSlug}/${item.slug}` as '/' });
  };

  const renderIcon = (item: BreadcrumbItem) => (
    <EntityIcon icon={item.icon} className="h-4 w-4 flex-shrink-0" />
  );

  return (
    <BreadcrumbSelector
      items={items}
      activeId={activeId}
      onSelect={handleSelect}
      placeholder="Search entity types..."
      label={currentLabel}
      renderIcon={renderIcon}
    />
  );
}
