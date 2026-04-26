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
import { type Member, useMembers } from '@/hooks/use-members';
import { cn } from '@/lib/utils';

interface MemberPickerProps {
  organizationId: string;
  value: string | undefined;
  onValueChange: (userId: string | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

function MemberAvatar({ member, size = 'sm' }: { member: Member; size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-6 w-6 text-xs';
  if (member.user.image) {
    return (
      <img
        src={member.user.image}
        alt={member.user.name}
        referrerPolicy="no-referrer"
        className={cn('rounded-full object-cover shrink-0', cls)}
      />
    );
  }
  return (
    <div
      className={cn(
        'rounded-full bg-muted flex items-center justify-center font-medium shrink-0',
        cls
      )}
    >
      {(member.user.name || member.user.email).charAt(0).toUpperCase()}
    </div>
  );
}

export function MemberPicker({
  organizationId,
  value,
  onValueChange,
  disabled,
  placeholder = 'Select member...',
  className,
}: MemberPickerProps) {
  const [open, setOpen] = useState(false);
  const { members, isLoading } = useMembers(organizationId);

  const selected = value ? members.find((m) => m.userId === value) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || isLoading}
          className={cn('w-full justify-between font-normal', className)}
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              <MemberAvatar member={selected} />
              <span className="truncate">{selected.user.name || selected.user.email}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{isLoading ? 'Loading...' : placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search members..." />
          <CommandList>
            <CommandEmpty>No members found.</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onValueChange(undefined);
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">Clear selection</span>
                </CommandItem>
              )}
              {members.map((member) => (
                <CommandItem
                  key={member.userId}
                  value={`${member.user.name} ${member.user.email}`}
                  onSelect={() => {
                    onValueChange(member.userId === value ? undefined : member.userId);
                    setOpen(false);
                  }}
                >
                  <MemberAvatar member={member} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{member.user.name || member.user.email}</p>
                    {member.user.name && (
                      <p className="truncate text-xs text-muted-foreground">{member.user.email}</p>
                    )}
                  </div>
                  <Check
                    className={cn(
                      'ml-auto h-4 w-4 shrink-0',
                      value === member.userId ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
