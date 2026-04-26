import { useNavigate } from '@tanstack/react-router';
import { BarChart3, Home, Lightbulb, LogOut, Moon, Plug, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { useOrgContext } from '@/hooks/use-org-context';
import { signOut } from '@/lib/auth';

function useTheme() {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  const toggle = useCallback(() => {
    const newIsDark = !isDark;
    setIsDark(newIsDark);
    document.documentElement.classList.toggle('dark', newIsDark);
    localStorage.setItem('theme', newIsDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldBeDark = stored === 'dark' || (!stored && prefersDark);
    setIsDark(shouldBeDark);
    document.documentElement.classList.toggle('dark', shouldBeDark);
  }, []);

  return { isDark, toggle };
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { isDark, toggle: toggleTheme } = useTheme();
  const { currentOwner } = useOrgContext();

  // Build contextual paths for navigation items
  const buildOwnerPath = (path: string): string | null => {
    if (!currentOwner) return null;
    return `/${currentOwner}${path}`;
  };

  const watchersPath = buildOwnerPath('/watchers');
  const connectionsPath = buildOwnerPath('/connectors');

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const runCommand = useCallback((command: () => void | Promise<void>) => {
    setOpen(false);
    Promise.resolve(command()).catch(console.error);
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigation">
          <CommandItem value="home" onSelect={() => runCommand(() => navigate({ to: '/' }))}>
            <Home className="mr-2 h-4 w-4" />
            <span>Home</span>
            <CommandShortcut>⌘H</CommandShortcut>
          </CommandItem>
          {watchersPath && (
            <CommandItem
              value="watchers"
              onSelect={() => runCommand(() => navigate({ to: watchersPath as '/' }))}
            >
              <BarChart3 className="mr-2 h-4 w-4" />
              <span>Watchers</span>
              <CommandShortcut>⌘I</CommandShortcut>
            </CommandItem>
          )}
          {connectionsPath && (
            <CommandItem
              value="connectors"
              onSelect={() => runCommand(() => navigate({ to: connectionsPath as '/' }))}
            >
              <Plug className="mr-2 h-4 w-4" />
              <span>Connectors</span>
            </CommandItem>
          )}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Create">
          {watchersPath && (
            <CommandItem
              value="new watcher"
              onSelect={() =>
                runCommand(() => navigate({ to: watchersPath as '/', search: { create: 'true' } }))
              }
            >
              <Lightbulb className="mr-2 h-4 w-4" />
              <span>New Watcher</span>
            </CommandItem>
          )}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem
            value="toggle theme dark light mode"
            onSelect={() => runCommand(toggleTheme)}
          >
            {isDark ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
            <span>{isDark ? 'Light Mode' : 'Dark Mode'}</span>
            <CommandShortcut>⌘D</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="sign out"
            onSelect={() =>
              runCommand(async () => {
                await signOut();
                window.location.href = '/';
              })
            }
          >
            <LogOut className="mr-2 h-4 w-4" />
            <span>Sign Out</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
