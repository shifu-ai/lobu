import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ConnectorDisplay, type ConnectorDisplayData } from './connector-display';

export interface ConnectorSelectorItem extends ConnectorDisplayData {
  count?: number;
}

export function ConnectorSelector({
  connectors,
  selectedKeys,
  onToggle,
  label = 'Connectors',
  searchPlaceholder = 'Search connectors...',
  emptyText = 'No connectors found',
}: {
  connectors: ConnectorSelectorItem[];
  selectedKeys: string[];
  onToggle: (connectorKey: string) => void;
  label?: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9">
          {label}
          {selectedKeys.length > 0 && (
            <Badge variant="secondary" className="ml-2 h-5 px-1.5">
              {selectedKeys.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {connectors.map((connector) => (
                <CommandItem key={connector.key} onSelect={() => onToggle(connector.key)}>
                  <Checkbox checked={selectedKeys.includes(connector.key)} className="mr-3" />
                  <ConnectorDisplay connector={connector} className="flex-1" />
                  {typeof connector.count === 'number' && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {connector.count.toLocaleString()}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
