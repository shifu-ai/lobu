import { describe, expect, it } from 'bun:test';
import { resolveConnectorMcpId } from '../connector-mcp-resolver';

function fakeConfigService(serverIds: string[]) {
  return {
    async getAllHttpServers(_agentId?: string) {
      return new Map(serverIds.map((id) => [id, { id } as never]));
    },
  };
}

describe('resolveConnectorMcpId', () => {
  it('resolves notion from agent settings-backed http servers', async () => {
    const result = await resolveConnectorMcpId({
      agentId: 'shifu-u-a4175b7e71f4',
      connectorKey: 'notion',
      configService: fakeConfigService(['notion', 'lobu-memory']),
    });
    expect(result).toEqual({ status: 'resolved', mcpId: 'notion' });
  });

  it('resolves shifu_toolbox via alias shifu-toolbox', async () => {
    const result = await resolveConnectorMcpId({
      agentId: 'shifu-u-a4175b7e71f4',
      connectorKey: 'shifu_toolbox',
      configService: fakeConfigService(['shifu-toolbox']),
    });
    expect(result).toEqual({ status: 'resolved', mcpId: 'shifu-toolbox' });
  });

  it('returns not_connected when no server entry exists — the ONLY legal source', async () => {
    const result = await resolveConnectorMcpId({
      agentId: 'shifu-u-a4175b7e71f4',
      connectorKey: 'google_workspace',
      configService: fakeConfigService(['notion']),
    });
    expect(result).toEqual({ status: 'not_connected' });
  });

  it('prefers canonical id when both alias forms present', async () => {
    const result = await resolveConnectorMcpId({
      agentId: 'a',
      connectorKey: 'shifu_toolbox',
      configService: fakeConfigService(['shifu_toolbox', 'shifu-toolbox']),
    });
    expect(result).toEqual({ status: 'resolved', mcpId: 'shifu-toolbox' });
  });
});
