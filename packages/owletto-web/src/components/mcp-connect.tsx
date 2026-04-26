import { ArrowUpRight, ChevronRight, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { API_URL } from '@/lib/api/core';
import { useAuthState } from '@/lib/auth-state';
import { getMcpInstallTargets } from '@/lib/mcp-install-targets';

function buildMcpUrl(baseUrl: string, orgSlug?: string): string {
  const path = orgSlug ? `/mcp/${orgSlug}` : '/mcp';
  if (!baseUrl) {
    return `http://localhost:8787${path}`;
  }
  try {
    const url = new URL(baseUrl);
    url.pathname = path;
    return url.toString();
  } catch {
    return `${baseUrl}${path}`;
  }
}

const ico = (d: string, viewBox = '0 0 24 24') => (
  <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox={viewBox} fill="currentColor">
    <path d={d} />
  </svg>
);

const ICONS: Record<string, React.ReactNode> = {
  Codex: ico(
    'M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z'
  ),
  ChatGPT: ico(
    'M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z'
  ),
  'Claude Desktop': ico(
    'M4.709 15.955l4.397-2.81a.766.766 0 0 1 .836.019l3.672 2.54a.78.78 0 0 0 .878-.013l6.085-4.476a.752.752 0 0 0 .066-1.135L13.108 3.2a.788.788 0 0 0-.99-.07L1.467 10.587A.77.77 0 0 0 1.2 11.4l2.464 4.168a.76.76 0 0 0 1.045.387zm14.083-2.654l-4.26 3.132a.773.773 0 0 1-.878.013l-3.672-2.54a.77.77 0 0 0-.836-.019l-4.583 2.928a.755.755 0 0 0-.226 1.078l2.562 3.694a.78.78 0 0 0 .812.313l11.64-3.2a.764.764 0 0 0 .532-.886l-1.091-4.513z',
    '0 0 24 24'
  ),
  'Claude Code': ico(
    'M4.709 15.955l4.397-2.81a.766.766 0 0 1 .836.019l3.672 2.54a.78.78 0 0 0 .878-.013l6.085-4.476a.752.752 0 0 0 .066-1.135L13.108 3.2a.788.788 0 0 0-.99-.07L1.467 10.587A.77.77 0 0 0 1.2 11.4l2.464 4.168a.76.76 0 0 0 1.045.387zm14.083-2.654l-4.26 3.132a.773.773 0 0 1-.878.013l-3.672-2.54a.77.77 0 0 0-.836-.019l-4.583 2.928a.755.755 0 0 0-.226 1.078l2.562 3.694a.78.78 0 0 0 .812.313l11.64-3.2a.764.764 0 0 0 .532-.886l-1.091-4.513z',
    '0 0 24 24'
  ),
  'Gemini CLI': ico(
    'M12 0C5.375 0 0 5.375 0 12s5.375 12 12 12 12-5.375 12-12S18.625 0 12 0zm0 2.182a9.818 9.818 0 0 1 6.943 2.875A13.765 13.765 0 0 1 12 8.727a13.765 13.765 0 0 1-6.943-3.67A9.818 9.818 0 0 1 12 2.182zM3.67 6.41A13.765 13.765 0 0 1 8.727 12a13.765 13.765 0 0 1-5.057 5.59 9.818 9.818 0 0 1 0-11.18zM12 21.818a9.818 9.818 0 0 1-6.943-2.875A13.765 13.765 0 0 1 12 15.273a13.765 13.765 0 0 1 6.943 3.67A9.818 9.818 0 0 1 12 21.818zm8.33-4.228A13.765 13.765 0 0 1 15.273 12a13.765 13.765 0 0 1 5.057-5.59 9.818 9.818 0 0 1 0 11.18z'
  ),
  Cursor: ico('M2.5 2L12.5 22L14.5 14.5L22 12.5L2.5 2Z'),
};

export function McpConnect({ orgSlug }: { orgSlug?: string }) {
  const { isAuthenticated } = useAuthState();
  const [copiedCommandName, setCopiedCommandName] = useState<string | null>(null);
  const [copiedMcpUrl, setCopiedMcpUrl] = useState(false);
  const [openItem, setOpenItem] = useState<string | null>(null);

  const mcpUrl = buildMcpUrl(API_URL, orgSlug);
  const installTargets = useMemo(() => getMcpInstallTargets(mcpUrl), [mcpUrl]);

  const copyText = async (value: string): Promise<boolean> => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  };

  const handleCopyMcpUrl = async () => {
    const success = await copyText(mcpUrl);
    if (success) {
      setCopiedMcpUrl(true);
      setTimeout(() => setCopiedMcpUrl(false), 1500);
    }
  };

  const handleCopyCommand = async (name: string, command: string) => {
    const success = await copyText(command);
    if (success) {
      setCopiedCommandName(name);
      setTimeout(() => setCopiedCommandName(null), 1500);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Use this MCP URL to connect your agent.</p>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <code className="flex-1 break-all font-mono text-xs text-muted-foreground">{mcpUrl}</code>
          <Button size="sm" variant="outline" onClick={handleCopyMcpUrl}>
            <Copy className="h-3 w-3" />
            {copiedMcpUrl ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {!isAuthenticated && (
          <p className="text-xs text-muted-foreground">
            Sign in to see connected OAuth agents and manage issued credentials.
          </p>
        )}
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        {installTargets.map((target) => {
          const isOpen = openItem === target.name;

          return (
            <Collapsible
              key={target.id}
              open={isOpen}
              onOpenChange={(nextOpen) => setOpenItem(nextOpen ? target.name : null)}
            >
              <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/50">
                <ChevronRight
                  className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
                <span className="text-muted-foreground">{ICONS[target.name]}</span>
                <span className="text-sm font-medium">{target.name}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 space-y-2 px-4 pb-3 pl-[3.25rem]">
                  <p className="text-xs text-muted-foreground">{target.description}</p>
                  {target.details?.map((detail) => (
                    <p key={detail} className="text-xs text-muted-foreground">
                      {detail}
                    </p>
                  ))}
                  {target.actions.map((action) =>
                    action.type === 'command' ? (
                      <div key={`${target.id}-${action.label}`} className="space-y-2">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          {action.label}
                        </p>
                        <code className="block rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                          {action.value}
                        </code>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleCopyCommand(`${target.name}:${action.label}`, action.value)
                          }
                        >
                          <Copy className="h-3 w-3" />
                          {copiedCommandName === `${target.name}:${action.label}`
                            ? 'Copied'
                            : 'Copy command'}
                        </Button>
                      </div>
                    ) : (
                      <a
                        key={`${target.id}-${action.label}`}
                        href={action.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-primary"
                      >
                        {action.label}
                        <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}
