import type { McpConfigService } from '../gateway/auth/mcp/config-service';

export type ToolboxMcpConnectorKey = 'notion' | 'google_workspace' | 'shifu_toolbox';
export type ToolboxMcpStatusConnectorKey = ToolboxMcpConnectorKey;

export function connectorKeyAliases(
  connectorKey: ToolboxMcpStatusConnectorKey
): ReadonlySet<string> {
  if (connectorKey === 'shifu_toolbox') {
    return new Set(['shifu_toolbox', 'shifu-toolbox']);
  }
  return new Set([connectorKey]);
}

export function canonicalMcpIdForConnector(connectorKey: ToolboxMcpStatusConnectorKey): string {
  return connectorKey === 'shifu_toolbox' ? 'shifu-toolbox' : connectorKey;
}

export async function resolveConnectorMcpId(input: {
  agentId: string;
  connectorKey: ToolboxMcpStatusConnectorKey;
  configService: Pick<McpConfigService, 'getAllHttpServers'>;
}): Promise<{ status: 'resolved'; mcpId: string } | { status: 'not_connected' }> {
  const servers = await input.configService.getAllHttpServers(input.agentId);
  const aliases = connectorKeyAliases(input.connectorKey);
  const canonical = canonicalMcpIdForConnector(input.connectorKey);

  if (servers.has(canonical)) return { status: 'resolved', mcpId: canonical };
  for (const id of servers.keys()) {
    if (aliases.has(id)) return { status: 'resolved', mcpId: id };
  }
  return { status: 'not_connected' };
}
