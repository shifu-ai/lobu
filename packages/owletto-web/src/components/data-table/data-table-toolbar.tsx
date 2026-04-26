import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useDebounce } from '@/hooks/use-debounce';

interface DataTableToolbarProps {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  actions?: React.ReactNode;
}

export function DataTableToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search...',
  actions,
}: DataTableToolbarProps) {
  const [localValue, setLocalValue] = useState(searchValue ?? '');
  const debouncedValue = useDebounce(localValue, 300);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    onSearchChange?.(debouncedValue);
  }, [debouncedValue, onSearchChange]);

  return (
    <div className="flex items-center justify-between gap-2 pb-4">
      {onSearchChange ? (
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            className="pl-8"
          />
        </div>
      ) : (
        <div />
      )}
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
