export type McpInstallTargetId =
  | 'codex'
  | 'chatgpt'
  | 'claude-desktop'
  | 'claude-code'
  | 'gemini-cli'
  | 'cursor'
  | 'openclaw';

export type McpInstallAction =
  | {
      type: 'command';
      label: string;
      value: string;
    }
  | {
      type: 'link';
      label: string;
      href: string;
    };

export interface McpInstallTarget {
  id: McpInstallTargetId;
  name: string;
  kind: 'manual' | 'command' | 'link' | 'hybrid';
  description: string;
  details?: string[];
  actions: McpInstallAction[];
  softwareIds?: string[];
}

const GEMINI_DOCS_LINK = 'https://geminicli.com/docs/tools/mcp-server/';

function buildCursorInstallLink(mcpUrl: string): string {
  const config = btoa(JSON.stringify({ url: mcpUrl }));
  const params = new URLSearchParams({ name: 'owletto', config });
  return `https://cursor.com/en-US/install-mcp?${params.toString()}`;
}

export function getMcpInstallTargets(mcpUrl: string): McpInstallTarget[] {
  return [
    {
      id: 'codex',
      name: 'Codex',
      kind: 'command',
      description: 'Run the CLI command to register the Lobu memory MCP server for Codex.',
      actions: [
        {
          type: 'command',
          label: 'Add MCP server',
          value: `codex mcp add owletto --url ${mcpUrl}`,
        },
      ],
      softwareIds: ['codex'],
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      kind: 'manual',
      description:
        'Settings -> Integrations -> Model Context Protocol -> Add Server. Name it Lobu memory and paste the MCP URL above.',
      actions: [],
      softwareIds: ['chatgpt'],
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      kind: 'manual',
      description:
        'Settings -> Connectors -> Add Custom Connector. Use the MCP URL above and enable the connector so it shows up in Claude search.',
      actions: [],
      softwareIds: ['claude-desktop'],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'command',
      description: 'Run the CLI command to register the Lobu memory MCP server for Claude Code.',
      actions: [
        {
          type: 'command',
          label: 'Add MCP server',
          value: `claude mcp add --transport http owletto ${mcpUrl}`,
        },
      ],
      softwareIds: ['claude-code'],
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      kind: 'hybrid',
      description:
        'Gemini CLI supports MCP servers via `gemini mcp add`. Use the docs to add Lobu memory as an HTTP server.',
      actions: [
        {
          type: 'command',
          label: 'Add MCP server',
          value: `gemini mcp add --transport http owletto ${mcpUrl}`,
        },
        { type: 'link', label: 'Gemini MCP docs', href: GEMINI_DOCS_LINK },
      ],
      softwareIds: ['gemini', 'gemini-cli'],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      kind: 'link',
      description:
        'Cursor has a pre-built MCP install page that can be opened with this workspace URL.',
      actions: [
        { type: 'link', label: 'Install via Cursor', href: buildCursorInstallLink(mcpUrl) },
      ],
      softwareIds: ['cursor'],
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      kind: 'hybrid',
      description:
        'Install the plugin, authenticate with Lobu memory, write plugin config, then verify MCP connectivity.',
      details: [
        'Use the `owletto` CLI first. If it is not installed globally, run the repo-local fallback from the Lobu memory skill references.',
      ],
      actions: [
        {
          type: 'command',
          label: 'Install plugin',
          value: 'openclaw plugins install owletto-openclaw-plugin',
        },
        {
          type: 'command',
          label: 'Log in to Lobu memory',
          value: `owletto login --mcpUrl ${mcpUrl}`,
        },
        {
          type: 'command',
          label: 'Write plugin config',
          value: `owletto configure --mcpUrl ${mcpUrl}`,
        },
        {
          type: 'command',
          label: 'Verify connectivity',
          value: `owletto health --mcpUrl ${mcpUrl}`,
        },
      ],
    },
  ];
}
