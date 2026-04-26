/**
 * Granularity Selector component
 * Dropdown for filtering watcher windows by granularity (daily/weekly/monthly/quarterly).
 * This is for viewing existing windows, not for setting a watcher schedule.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TimeGranularity } from '@/hooks/use-watchers';
import { WATCHER_TIME_GRANULARITIES } from '@/lib/watcher-time';

const GRANULARITIES: { value: TimeGranularity; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  ...WATCHER_TIME_GRANULARITIES.map((value) => ({
    value,
    label: value.slice(0, 1).toUpperCase() + value.slice(1),
  })),
];

interface GranularitySelectorProps {
  value?: TimeGranularity;
  onChange: (value: TimeGranularity) => void;
  availableGranularities?: TimeGranularity[];
  placeholder?: string;
  className?: string;
  withLabelSuffix?: boolean;
}

function getOptionLabel(label: string, withLabelSuffix?: boolean): string {
  return withLabelSuffix ? `${label} granularity` : label;
}

export function GranularitySelector({
  value,
  onChange,
  availableGranularities,
  placeholder = 'Granularity',
  className,
  withLabelSuffix = false,
}: GranularitySelectorProps) {
  const options = availableGranularities
    ? GRANULARITIES.filter((g) => g.value === 'auto' || availableGranularities.includes(g.value))
    : GRANULARITIES;

  const allLabels = new Map(GRANULARITIES.map((item) => [item.value, item.label]));

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className ?? 'w-32'}>
        <SelectValue placeholder={placeholder}>
          {value ? getOptionLabel(allLabels.get(value) ?? String(value), withLabelSuffix) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {getOptionLabel(option.label, withLabelSuffix)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
