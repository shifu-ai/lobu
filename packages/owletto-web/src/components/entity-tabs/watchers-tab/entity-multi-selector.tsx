import { Check, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type EntityWithChildren, useEntities } from '@/lib/api';
import { cn } from '@/lib/utils';

interface FlatEntity {
  id: number;
  name: string;
  entityType: string;
}

function flattenEntities(entities: EntityWithChildren[]): FlatEntity[] {
  const result: FlatEntity[] = [];
  for (const entity of entities) {
    result.push({ id: entity.id, name: entity.name, entityType: entity.entity_type });
    if (entity.children && entity.children.length > 0) {
      result.push(...flattenEntities(entity.children));
    }
  }
  return result;
}

interface EntityMultiSelectorProps {
  organizationId: string;
  value: number[];
  onChange: (entityIds: number[]) => void;
  entities?: FlatEntity[];
  className?: string;
}

export function EntityMultiSelector({
  organizationId,
  value,
  onChange,
  entities: entitiesProp,
  className,
}: EntityMultiSelectorProps) {
  const [open, setOpen] = useState(false);
  const { data: entityTree = [] } = useEntities(entitiesProp ? undefined : organizationId);
  const entities = useMemo(
    () => entitiesProp ?? flattenEntities(entityTree),
    [entitiesProp, entityTree]
  );
  const selectedIds = new Set(value);
  const selectedEntities = entities.filter((entity) => selectedIds.has(entity.id));

  const toggleEntity = (entityId: number) => {
    const next = new Set(selectedIds);
    if (next.has(entityId)) next.delete(entityId);
    else next.add(entityId);
    onChange(Array.from(next).sort((a, b) => a - b));
  };

  const buttonLabel =
    selectedEntities.length === 0
      ? 'All entities'
      : selectedEntities.length === 1
        ? selectedEntities[0].name
        : `${selectedEntities.length} entities selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('justify-between', className)}
        >
          {buttonLabel}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Filter entities..." />
          <CommandList>
            <CommandEmpty>No entities found.</CommandEmpty>
            <CommandGroup>
              {entities.map((entity) => {
                const isSelected = selectedIds.has(entity.id);
                return (
                  <CommandItem
                    key={entity.id}
                    value={`${entity.name} ${entity.entityType}`}
                    onSelect={() => toggleEntity(entity.id)}
                    className="cursor-pointer"
                  >
                    <Check
                      className={cn('mr-2 h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')}
                    />
                    <span>
                      {entity.name}{' '}
                      <span className="text-muted-foreground text-xs">({entity.entityType})</span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
