import { describe, expect, test } from "bun:test";
import type { AgentSettings } from "@lobu/core";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";

function persistentReader(settings: AgentSettings | null) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      async getSettings(agentId: string) {
        calls.push(`getSettings:${agentId}`);
        return settings;
      },
      async hasSettings(agentId: string) {
        calls.push(`hasSettings:${agentId}`);
        return settings !== null;
      },
      async getMetadata(agentId: string) {
        calls.push(`getMetadata:${agentId}`);
        return null;
      },
      async saveMetadata() {},
      async updateMetadata() {},
      async deleteMetadata() {},
      async hasAgent() {
        return false;
      },
      async listAgents() {
        return [];
      },
      async saveSettings() {
        calls.push("raw-save");
      },
      async updateSettings() {
        calls.push("raw-update");
      },
    },
  };
}

describe("AgentSettingsStore persistent reader boundary", () => {
  test("declared agent reads bypass the persistent reader", async () => {
    const reader = persistentReader(null);
    const store = new AgentSettingsStore(reader.store);
    const declared = { model: "declared/model", updatedAt: 11 } as AgentSettings;
    store.setDeclaredAgents({
      get(agentId: string) {
        return agentId === "declared-agent" ? { settings: declared } : undefined;
      },
    } as never);

    expect(await store.getSettings("declared-agent")).toEqual(declared);
    expect(await store.hasSettings("declared-agent")).toBe(true);
    expect(await store.getMetadata("declared-agent")).toBeNull();
    expect(reader.calls).toEqual([]);
  });

  test("persistent reads are delegated without exposing raw settings writers", async () => {
    const settings = { model: "persistent/model", updatedAt: 12 } as AgentSettings;
    const reader = persistentReader(settings);
    const store = new AgentSettingsStore(reader.store);

    expect(await store.getSettings("agent-1")).toEqual(settings);
    expect(await store.hasSettings("agent-1")).toBe(true);
    expect(await store.getMetadata("agent-1")).toBeNull();
    expect(reader.calls).toEqual([
      "getSettings:agent-1",
      "getSettings:agent-1",
      "getMetadata:agent-1",
    ]);
    expect("saveSettings" in store).toBe(false);
    expect("updateSettings" in store).toBe(false);
    expect("deleteSettings" in store).toBe(false);
    expect(reader.calls).not.toContain("raw-save");
    expect(reader.calls).not.toContain("raw-update");
  });

  test("ephemeral auth profiles remain shared and deletable", () => {
    const store = new AgentSettingsStore(persistentReader(null).store);
    const registry = store.getEphemeralAuthProfiles();
    const profiles = [
      { providerId: "claude", type: "api-key", key: "placeholder" },
    ] as never;

    registry.set("agent-1", profiles);
    expect(registry.get("agent-1")).toBe(profiles);
    registry.delete("agent-1");
    expect(registry.get("agent-1")).toBeUndefined();
  });
});
