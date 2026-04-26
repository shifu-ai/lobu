/**
 * Schedule Selector component
 * Dropdown with cron presets + custom cron input for watcher/feed scheduling.
 */

import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SCHEDULE_PRESETS = [
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 9 * * *', label: 'Daily at 9am' },
  { value: '0 9 * * 1', label: 'Weekly Monday 9am' },
  { value: 'custom', label: 'Custom cron...' },
];

interface ScheduleSelectorProps {
  value?: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function ScheduleSelector({
  value,
  onChange,
  placeholder = 'No schedule',
  className,
}: ScheduleSelectorProps) {
  const currentValue = value ?? '';
  const isPreset = SCHEDULE_PRESETS.some((p) => p.value === currentValue);
  const [showCustom, setShowCustom] = useState(!isPreset && currentValue !== '');

  const handleSelectChange = (selected: string) => {
    if (selected === 'custom') {
      setShowCustom(true);
    } else {
      setShowCustom(false);
      onChange(selected);
    }
  };

  if (!currentValue && !showCustom) {
    return (
      <Select onValueChange={handleSelectChange}>
        <SelectTrigger className={className ?? 'w-full'}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {SCHEDULE_PRESETS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
              {option.value !== 'custom' && (
                <span className="ml-2 text-xs text-muted-foreground font-mono">{option.value}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {showCustom ? (
          <Input
            placeholder="0 */6 * * *"
            value={currentValue}
            onChange={(e) => onChange(e.target.value)}
            className="font-mono text-sm flex-1"
          />
        ) : (
          <Select value={currentValue} onValueChange={handleSelectChange}>
            <SelectTrigger className={className ?? 'w-full flex-1'}>
              <SelectValue>
                {SCHEDULE_PRESETS.find((p) => p.value === currentValue)?.label ?? currentValue}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_PRESETS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                  {option.value !== 'custom' && (
                    <span className="ml-2 text-xs text-muted-foreground font-mono">
                      {option.value}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => {
            setShowCustom(false);
            onChange('');
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
