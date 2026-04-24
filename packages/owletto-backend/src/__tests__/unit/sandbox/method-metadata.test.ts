import { describe, expect, it } from "bun:test";
import {
  BANNED_PATHS,
  METHOD_METADATA,
  type MethodAccess,
} from "../../../sandbox/method-metadata";

describe("method-metadata", () => {
  it("is non-empty", () => {
    expect(Object.keys(METHOD_METADATA).length).toBeGreaterThan(20);
  });

  it("has valid access levels on every entry", () => {
    const valid: MethodAccess[] = ["read", "write", "external"];
    for (const [path, meta] of Object.entries(METHOD_METADATA)) {
      expect(valid).toContain(meta.access);
      expect(meta.summary.length).toBeGreaterThan(0);
      if (meta.example) {
        expect(meta.example).toContain("client.");
      }
      void path;
    }
  });

  it("uses dotted path keys", () => {
    for (const path of Object.keys(METHOD_METADATA)) {
      expect(path).toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)?$/);
    }
  });

  it("never exposes banned paths", () => {
    for (const banned of BANNED_PATHS) {
      expect(METHOD_METADATA).not.toHaveProperty(banned);
    }
  });

  it("classifies external side-effects correctly for known methods", () => {
    expect(METHOD_METADATA["operations.execute"].access).toBe("external");
    expect(METHOD_METADATA["feeds.trigger"].access).toBe("external");
    expect(METHOD_METADATA["connections.test"].access).toBe("external");
  });

  it("classifies reads correctly for known methods", () => {
    expect(METHOD_METADATA["entities.list"].access).toBe("read");
    expect(METHOD_METADATA["watchers.list"].access).toBe("read");
    expect(METHOD_METADATA["organizations.list"].access).toBe("read");
  });
});
