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

interface EntitySelectorProps {
  organizationId: string;
  value?: number;
  onChange: (entityId: number) => void;
  className?: string;
}

export function EntitySelector({
  organizationId,
  value,
  onChange,
  className,
}: EntitySelectorProps) {
  const [open, setOpen] = useState(false);
  const { data: entityTree = [] } = useEntities(organizationId);
  const flatEntities = flattenEntities(entityTree);
  const selected = flatEntities.find((e) => e.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('w-full justify-between', className)}
        >
          {selected ? `${selected.name} (${selected.entityType})` : 'Select entity...'}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search entities..." />
          <CommandList>
            <CommandEmpty>No entities found.</CommandEmpty>
            <CommandGroup>
              {flatEntities.map((entity) => (
                <CommandItem
                  key={entity.id}
                  value={`${entity.name} ${entity.entityType}`}
                  onSelect={() => {
                    onChange(entity.id);
                    setOpen(false);
                  }}
                  className="cursor-pointer"
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === entity.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span>
                    {entity.name}{' '}
                    <span className="text-muted-foreground text-xs">({entity.entityType})</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
