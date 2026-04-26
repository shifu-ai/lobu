import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import {
  ConnectorSelector,
  type ConnectorSelectorItem,
} from '@/components/connectors/connector-selector';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import type { PartialEventFilters } from '@/lib/event-filters';

interface EventsFilterBarProps {
  filters: PartialEventFilters;
  onFiltersChange: (updates: Partial<PartialEventFilters>) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
  connectors: ConnectorSelectorItem[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export function EventsFilterBar({
  filters,
  onFiltersChange,
  onClearFilters,
  hasActiveFilters,
  connectors,
  searchQuery,
  onSearchChange,
}: EventsFilterBarProps) {
  // Convert date range for picker
  const dateRange: DateRange | undefined = filters.dateRange
    ? { from: filters.dateRange[0], to: filters.dateRange[1] }
    : undefined;

  const handleDateChange = (range: DateRange | undefined) => {
    if (range?.from && range?.to) {
      onFiltersChange({ dateRange: [range.from, range.to] });
    } else {
      onFiltersChange({ dateRange: null });
    }
  };

  const handleConnectorToggle = (platform: string) => {
    const current = filters.platforms || [];
    const updated = current.includes(platform)
      ? current.filter((p) => p !== platform)
      : [...current, platform];
    onFiltersChange({ platforms: updated });
  };

  return (
    <div className="space-y-4">
      {/* Search and primary filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search items..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>

        {connectors.length > 0 && (
          <ConnectorSelector
            connectors={connectors}
            selectedKeys={filters.platforms || []}
            onToggle={handleConnectorToggle}
          />
        )}

        {/* Date range */}
        <DateRangePicker
          value={dateRange}
          onChange={handleDateChange}
          placeholder="Date range"
          className="w-auto"
        />

        {/* Sort */}
        <Select
          value={`${filters.sortBy || 'score'}-${filters.sortOrder || 'desc'}`}
          onValueChange={(value) => {
            const [sortBy, sortOrder] = value.split('-') as ['date' | 'score', 'asc' | 'desc'];
            onFiltersChange({ sortBy, sortOrder });
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date-desc">Newest</SelectItem>
            <SelectItem value="date-asc">Oldest</SelectItem>
            <SelectItem value="score-desc">Top Score</SelectItem>
            <SelectItem value="score-asc">Low Score</SelectItem>
          </SelectContent>
        </Select>

        {/* Review status */}
        <Select
          value={filters.reviewStatus || 'all'}
          onValueChange={(value) =>
            onFiltersChange({ reviewStatus: value as 'all' | 'user' | 'system' | 'llm' })
          }
        >
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="user">Manual</SelectItem>
            <SelectItem value="system">Auto</SelectItem>
            <SelectItem value="llm">LLM</SelectItem>
          </SelectContent>
        </Select>

        {/* Approval status */}
        <Select
          value={filters.interactionStatus || 'all'}
          onValueChange={(value) =>
            onFiltersChange({ interactionStatus: value === 'all' ? null : value })
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Approval status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Pending Approval</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>

        {/* More filters */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" className="h-9 w-9">
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="end">
            <div className="space-y-4">
              <h4 className="font-medium">More Filters</h4>

              {/* Engagement score */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Engagement Score</span>
                  <span className="text-muted-foreground">
                    {filters.engagementRange?.[0] ?? 0} - {filters.engagementRange?.[1] ?? 100}
                  </span>
                </div>
                <Slider
                  value={filters.engagementRange || [0, 100]}
                  onValueChange={(value) =>
                    onFiltersChange({ engagementRange: value as [number, number] })
                  }
                  min={0}
                  max={100}
                  step={5}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* Clear filters */}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={onClearFilters}>
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
