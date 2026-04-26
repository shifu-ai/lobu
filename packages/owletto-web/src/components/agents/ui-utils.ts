const PLATFORM_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  discord: 'Discord',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini CLI',
  gchat: 'Google Chat',
  mcp: 'MCP',
  openclaw: 'OpenClaw',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

const KNOWN_MCP_CLIENT_ALIASES = new Map<string, string>([
  ['chatgpt', 'ChatGPT'],
  ['claude code', 'Claude Code'],
  ['claude desktop', 'Claude Desktop'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['gemini', 'Gemini'],
  ['gemini cli', 'Gemini CLI'],
  ['openclaw', 'OpenClaw'],
  ['openclaw owletto', 'OpenClaw'],
  ['openclaw owletto plugin', 'OpenClaw'],
  ['owletto cli', 'Lobu memory CLI'],
]);

function normalizeClientHint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatDateTime(value?: number | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

export function mcpSoftwareLabel(...hints: Array<string | null | undefined>): string | null {
  for (const hint of hints) {
    if (!hint) continue;
    if (PLATFORM_LABELS[hint]) {
      const label = PLATFORM_LABELS[hint];
      if (label !== 'MCP') return label;
    }

    const alias = KNOWN_MCP_CLIENT_ALIASES.get(normalizeClientHint(hint));
    if (alias) return alias;
  }

  return null;
}

export function statusTone(status: string): string {
  if (status === 'active' || status === 'connected' || status === 'authorized') {
    return 'bg-green-500/15 text-green-700 dark:text-green-400';
  }
  if (status === 'error' || status === 'revoked') {
    return 'bg-red-500/15 text-red-700 dark:text-red-400';
  }
  return 'bg-muted text-muted-foreground';
}
