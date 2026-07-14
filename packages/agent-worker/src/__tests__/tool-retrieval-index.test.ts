import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { catalogEntryForTool } from "../openclaw/tool-catalog";
import {
  buildToolDescriptor,
  getOrBuildToolDescriptor,
  inventoryFingerprint,
  qualifiedToolKey,
  type ToolDescriptor,
  toolIdentityKey,
} from "../openclaw/tool-descriptor";
import {
  buildToolRetrievalIndex,
  clearToolRetrievalIndexCacheForTests,
  getOrBuildToolRetrievalIndex,
  searchToolRetrievalIndex,
  toolRetrievalIndexCacheStats,
} from "../openclaw/tool-retrieval-index";
import { routeToolEntries } from "../openclaw/tool-router";
import { tokenizeToolText } from "../openclaw/tool-tokenizer";

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  extras: Record<string, unknown> = {}
): McpToolDef {
  return {
    name,
    description,
    inputSchema: { type: "object", properties },
    ...extras,
  };
}

describe("tool tokenizer", () => {
  test("tokenizes camel case English and overlapping CJK terms", () => {
    const tokens = tokenizeToolText("manageSchedules 提醒我吃午餐");

    expect(tokens).toContain("manage");
    expect(tokens).toContain("schedules");
    expect(tokens).toContain("提醒");
    expect(tokens).toContain("醒我");
  });

  test("normalizes NFKC, strips controls, splits separators, and deduplicates", () => {
    expect(tokenizeToolText("Ｆｏｏ_bar-baz42\u0000 foo BAR baz42")).toEqual([
      "foo",
      "bar",
      "baz42",
    ]);
  });
});

describe("tool descriptors", () => {
  test("reuses immutable descriptor snapshots through the unified accounted budget", () => {
    const source = Object.freeze({
      ...tool("search_students", "Find students", {
        email: Object.freeze({
          type: "string",
          description: "Student email",
        }),
      }),
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          email: Object.freeze({
            type: "string",
            description: "Student email",
          }),
        }),
      }),
    });

    const first = getOrBuildToolDescriptor(source, "school", 0);
    const second = getOrBuildToolDescriptor(source, "school", 0);
    const reordered = getOrBuildToolDescriptor(source, "school", 1);

    expect(first).toBe(second);
    expect(reordered).not.toBe(first);
    expect(reordered.originalIndex).toBe(1);
    expect(inventoryFingerprint([first])).not.toBe(
      inventoryFingerprint([reordered])
    );
  });

  test("does not cache mutable descriptor sources across mutations", () => {
    const source = tool("search_students", "Find students");
    const first = getOrBuildToolDescriptor(source, "school", 0);
    source.description = "Find active students by cohort";
    const second = getOrBuildToolDescriptor(source, "school", 0);

    expect(second).not.toBe(first);
    expect(second.description).toBe("Find active students by cohort");
    expect(inventoryFingerprint([second])).not.toBe(
      inventoryFingerprint([first])
    );
  });
  test("bounds searchable text and applies the exact reminder override", () => {
    const descriptor = buildToolDescriptor(
      tool("manage_schedules", "x".repeat(40_000), {
        delay_minutes: {
          type: "number",
          description: "Delay before sending the reminder",
        },
      }),
      "lobu-memory",
      4
    );

    expect(descriptor.key).toBe("lobu-memory/manage_schedules");
    expect(descriptor.indexedTextBytes).toBeLessThanOrEqual(16 * 1024);
    expect(descriptor.parameterNames).toContain("delay_minutes");
    expect(descriptor.destinations).toContain("personal_reminder");
    expect(descriptor.mutatesState).toBe(true);
  });

  test("bounds oversized optional searchable metadata", () => {
    const titledTool = Object.assign(tool("search_students", "Find students"), {
      title: "課".repeat(20_000),
    });

    const descriptor = buildToolDescriptor(titledTool, "school", 0);

    expect(descriptor.indexedTextBytes).toBeLessThanOrEqual(16 * 1024);
  });

  test("preserves a huge raw identity while bounding indexed identity text", () => {
    const hugeName = `search_${"x".repeat(20_000)}`;
    const descriptor = buildToolDescriptor(
      tool(hugeName, "Find records"),
      "large-mcp",
      0
    );
    const searchable = descriptor as ToolDescriptor & {
      indexedKey?: string;
      indexedName?: string;
    };

    expect(descriptor.name).toBe(hugeName);
    expect(descriptor.key).toBe(`large-mcp/${hugeName}`);
    expect(searchable.indexedName).toBeDefined();
    expect(searchable.indexedKey).toBeDefined();
    expect(descriptor.indexedTextBytes).toBeLessThanOrEqual(16 * 1024);
  });

  test("does not apply exact overrides after sanitizing raw identity", () => {
    const descriptor = buildToolDescriptor(
      tool("manage_schedules", "Manage schedules"),
      " lobu-memory ",
      0
    );

    expect(descriptor.destinations).toEqual([]);
    expect(descriptor.mutatesState).toBe(true);
  });

  test("does not confuse an unqualified slashed name with a qualified override", () => {
    const descriptor = buildToolDescriptor(
      tool("lobu-memory/manage_schedules", "Foreign schedule tool"),
      "",
      0
    );

    expect(descriptor.key).toBe("lobu-memory/manage_schedules");
    expect(descriptor.destinations).toEqual([]);
    expect(descriptor.mutatesState).toBe(true);
  });

  test("does not share mutable override arrays across descriptors", () => {
    const first = buildToolDescriptor(
      tool("manage_schedules", "Manage schedules"),
      "lobu-memory",
      0
    );
    first.operations.push("read");
    first.positiveExamples.push("mutated example");

    const second = buildToolDescriptor(
      tool("manage_schedules", "Manage schedules"),
      "lobu-memory",
      1
    );

    expect(second.operations).not.toContain("read");
    expect(second.positiveExamples).not.toContain("mutated example");
  });

  test("honors standard destructive hints and ignores arbitrary privilege labels", () => {
    const destructiveReadName = buildToolDescriptor(
      tool(
        "get_report",
        "Get report",
        {},
        {
          annotations: { destructiveHint: true },
        }
      ),
      "remote",
      0
    );
    const selfLabeledSave = buildToolDescriptor(
      tool(
        "save_report",
        "Save report",
        {},
        {
          _meta: { shifuTool: { readOnly: true, mutatesState: false } },
        }
      ),
      "untrusted-remote",
      1
    );
    const selfLabeledOpaqueRead = buildToolDescriptor(
      tool(
        "do_alpha",
        "Handle alpha",
        {},
        {
          annotations: { readOnlyHint: true },
        }
      ),
      "untrusted-remote",
      2
    );
    const trustedOpaqueRead = buildToolDescriptor(
      tool(
        "do_alpha",
        "Handle alpha",
        {},
        {
          _meta: { shifuTool: { readOnly: true, mutatesState: false } },
        }
      ),
      "shifu-toolbox",
      3
    );
    expect(destructiveReadName.mutatesState).toBe(true);
    expect(selfLabeledSave.mutatesState).toBe(true);
    expect(selfLabeledOpaqueRead.mutatesState).toBe(true);
    // A server id alone is not trusted provenance after the discovery
    // identity hardening; opaque self-labelled tools remain mutating.
    expect(trustedOpaqueRead.mutatesState).toBe(true);
  });

  test("reads metadata titles using dispatcher precedence", () => {
    const metaTitle = buildToolDescriptor(
      Object.assign(tool("meta_tool", "Meta tool"), {
        _meta: { title: "Metadata title" },
        annotations: { title: "Annotation title" },
      }),
      "mcp",
      0
    );
    const annotationsTitle = buildToolDescriptor(
      Object.assign(tool("annotation_tool", "Annotation tool"), {
        annotations: { title: "Annotation fallback" },
      }),
      "mcp",
      1
    );

    expect(metaTitle.title).toBe("Metadata title");
    expect(annotationsTitle.title).toBe("Annotation fallback");
  });

  test("fingerprints clones deterministically and searchable changes distinctly", () => {
    const source = tool("search_students", "Find enrolled students");
    const original = buildToolDescriptor(source, "school", 1);
    const clone = buildToolDescriptor(structuredClone(source), "school", 1);
    const changed = buildToolDescriptor(
      tool("search_students", "Find active enrolled students"),
      "school",
      1
    );

    expect(inventoryFingerprint([original])).toBe(
      inventoryFingerprint([clone])
    );
    expect(inventoryFingerprint([original])).not.toBe(
      inventoryFingerprint([changed])
    );
  });

  test("fingerprints original order because it is the final compatibility tie-break", () => {
    const first = buildToolDescriptor(tool("alpha", "same"), "mcp", 0);
    const second = buildToolDescriptor(tool("beta", "same"), "mcp", 1);
    const reorderedFirst = buildToolDescriptor(tool("alpha", "same"), "mcp", 1);
    const reorderedSecond = buildToolDescriptor(tool("beta", "same"), "mcp", 0);

    expect(inventoryFingerprint([first, second])).not.toBe(
      inventoryFingerprint([reorderedFirst, reorderedSecond])
    );
  });

  test("fingerprints descriptor array order with unchanged descriptor objects", () => {
    const first = buildToolDescriptor(tool("alpha", "same"), "mcp", 0);
    const second = buildToolDescriptor(tool("beta", "same"), "mcp", 1);

    expect(inventoryFingerprint([first, second])).not.toBe(
      inventoryFingerprint([second, first])
    );
  });
});

describe("tool retrieval index", () => {
  test("reuses the same immutable inventory index", () => {
    clearToolRetrievalIndexCacheForTests();
    const descriptors = Array.from({ length: 500 }, (_, index) =>
      buildToolDescriptor(
        tool(`tool_${index}`, `Search synthetic record ${index}`),
        "synthetic",
        index
      )
    );

    const first = getOrBuildToolRetrievalIndex(descriptors);
    const second = getOrBuildToolRetrievalIndex(descriptors);

    expect(first.index).toBe(second.index);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
  });

  test("does not reuse an equal descriptor index across release authority", () => {
    clearToolRetrievalIndexCacheForTests();
    const descriptors = [
      buildToolDescriptor(tool("search", "Search"), "mcp", 0),
    ];
    const base = {
      environment: "production",
      agentId: "shifu-u-1",
      releaseId: "release-1",
      releaseSequence: 1,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      snapshotExpiresAt: "2099-01-01T00:00:00.000Z",
      effectiveInventoryFingerprint: "b".repeat(64),
      effectivePolicyFingerprint: "c".repeat(64),
      grantProjectionFingerprint: "d".repeat(64),
    };
    const first = getOrBuildToolRetrievalIndex(descriptors, {
      cacheContext: base,
    });
    const same = getOrBuildToolRetrievalIndex(descriptors, {
      cacheContext: base,
    });
    const advanced = getOrBuildToolRetrievalIndex(descriptors, {
      cacheContext: { ...base, releaseSequence: 2 },
    });
    const policyChanged = getOrBuildToolRetrievalIndex(descriptors, {
      cacheContext: { ...base, effectivePolicyFingerprint: "e".repeat(64) },
    });
    const authorityChanges = (
      [
        { environment: "staging" },
        { agentId: "shifu-u-2" },
        { releaseId: "release-2" },
        { snapshotDigest: `sha256:${"f".repeat(64)}` },
        { snapshotExpiresAt: "2099-01-02T00:00:00.000Z" },
        { effectiveInventoryFingerprint: "1".repeat(64) },
        { grantProjectionFingerprint: "2".repeat(64) },
      ] as const
    ).map((change) =>
      getOrBuildToolRetrievalIndex(descriptors, {
        cacheContext: { ...base, ...change },
      })
    );
    expect(same.cacheHit).toBe(true);
    expect(same.index).toBe(first.index);
    expect(advanced.cacheHit).toBe(false);
    expect(policyChanged.cacheHit).toBe(false);
    expect(authorityChanges.every((entry) => !entry.cacheHit)).toBe(true);
  });

  test("does not retain an index above the per-index cache budget", () => {
    clearToolRetrievalIndexCacheForTests();
    const descriptors = Array.from({ length: 600 }, (_, index) =>
      buildToolDescriptor(
        tool(`large_${index}`, `${index}-${"x".repeat(16_000)}`),
        "synthetic",
        index
      )
    );

    const first = getOrBuildToolRetrievalIndex(descriptors);
    const second = getOrBuildToolRetrievalIndex(descriptors);

    expect(first.index.mode).toBe("linear");
    expect(first.index.estimatedBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(toolRetrievalIndexCacheStats().entries).toBe(0);
  });

  test("linear fallback keeps the final tool searchable", () => {
    const descriptors = Array.from({ length: 2_001 }, (_, index) =>
      buildToolDescriptor(
        tool(`tool_${index}`, `Synthetic utility ${index}`),
        "synthetic",
        index
      )
    );
    descriptors[2_000] = buildToolDescriptor(
      tool("manage_schedules", "Manage delayed reminders"),
      "lobu-memory",
      2_000
    );

    const index = buildToolRetrievalIndex(descriptors, { maxIndexBytes: 1 });

    expect(index.mode).toBe("linear");
    expect(
      searchToolRetrievalIndex(index, "五分鐘後提醒我", 5)[0]?.descriptor.key
    ).toBe("lobu-memory/manage_schedules");
  });

  test("LRU estimated bytes never exceed the worker cache budget", () => {
    clearToolRetrievalIndexCacheForTests();
    for (let version = 0; version < 20; version++) {
      const descriptors = Array.from({ length: 500 }, (_, index) =>
        buildToolDescriptor(
          tool(
            `tool_${version}_${index}`,
            `Search version ${version} synthetic record ${index} ${"x".repeat(3_000)}`
          ),
          "synthetic",
          index
        )
      );
      getOrBuildToolRetrievalIndex(descriptors);
    }

    expect(toolRetrievalIndexCacheStats().estimatedBytes).toBeLessThanOrEqual(
      32 * 1024 * 1024
    );
    expect(toolRetrievalIndexCacheStats().evictionCount).toBeGreaterThan(0);
  }, 15_000);
  test("ranks personal reminders and Google Calendar requests by semantics", () => {
    const reminder = buildToolDescriptor(
      tool("manage_schedules", "Manage agent schedules"),
      "lobu-memory",
      0
    );
    const calendar = buildToolDescriptor(
      tool("gws_calendar_events_create", "Create a calendar event"),
      "google_workspace",
      1
    );
    const index = buildToolRetrievalIndex([reminder, calendar]);

    expect(
      searchToolRetrievalIndex(index, "五分鐘後提醒我", 2)[0]?.descriptor.key
    ).toBe("lobu-memory/manage_schedules");
    expect(
      searchToolRetrievalIndex(index, "放進 Google Calendar", 2)[0]?.descriptor
        .key
    ).toBe("google_workspace/gws_calendar_events_create");
  });

  test("retrieves an unknown tool from its parameter description", () => {
    const distractor = buildToolDescriptor(
      tool("list_courses", "List available courses"),
      "school",
      0
    );
    const studentSearch = buildToolDescriptor(
      tool("search_students", "Search students", {
        email: { type: "string", description: "學員電子郵件" },
      }),
      "school",
      1
    );
    const index = buildToolRetrievalIndex([distractor, studentSearch]);

    expect(
      searchToolRetrievalIndex(index, "用 email 查學員", 2)[0]?.descriptor.key
    ).toBe("school/search_students");
  });

  test("conservatively estimates serialized map and posting storage", () => {
    const descriptor = buildToolDescriptor(
      tool(
        "search_many",
        Array.from({ length: 200 }, (_, index) => `term${index}`).join(" ")
      ),
      "mcp",
      0
    );
    const index = buildToolRetrievalIndex([descriptor]);
    const serializedLowerBound = Buffer.byteLength(
      JSON.stringify({
        descriptors: index.descriptors,
        documentFrequency: [...index.documentFrequency],
        postings: [...index.postings],
      }),
      "utf8"
    );
    // Serialization covers payload bytes but not the two Map node structures.
    const minimumMapNodeBytes =
      (index.documentFrequency.size + index.postings.size) * 24;

    expect(index.estimatedBytes).toBeGreaterThanOrEqual(
      serializedLowerBound + minimumMapNodeBytes
    );
  });

  test("uses linear mode without dropping descriptors under a tiny budget", () => {
    const descriptors = [
      buildToolDescriptor(tool("alpha", "first tool"), "mcp", 0),
      buildToolDescriptor(tool("beta", "second tool"), "mcp", 1),
    ];
    const index = buildToolRetrievalIndex(descriptors, { maxIndexBytes: 1 });

    expect(index.mode).toBe("linear");
    expect(index.descriptors).toHaveLength(2);
    expect(index.postings.size).toBe(0);
    expect(index.documentFrequency.size).toBe(0);
    expect(index.documentIdsByIdentity.size).toBe(0);
    expect(searchToolRetrievalIndex(index, "tool", 2)).toHaveLength(2);
  });

  test("returns no unrelated matches in either inverted or linear mode", () => {
    const descriptors = [
      buildToolDescriptor(tool("alpha", "first utility"), "mcp", 0),
      buildToolDescriptor(tool("beta", "second utility"), "mcp", 1),
    ];
    const inverted = buildToolRetrievalIndex(descriptors);
    const linear = buildToolRetrievalIndex(descriptors, { maxIndexBytes: 1 });

    expect(
      searchToolRetrievalIndex(inverted, "completely unrelated", 2)
    ).toEqual([]);
    expect(searchToolRetrievalIndex(linear, "completely unrelated", 2)).toEqual(
      []
    );
  });

  test("keeps semantic reminder overrides relevant in linear mode", () => {
    const reminder = buildToolDescriptor(
      tool("manage_schedules", "Manage delayed agent schedules"),
      "lobu-memory",
      0
    );
    const index = buildToolRetrievalIndex([reminder], { maxIndexBytes: 1 });

    expect(
      searchToolRetrievalIndex(index, "稍後提醒我回覆客戶", 1)[0]?.descriptor
        .name
    ).toBe("manage_schedules");
  });

  test("uses inverted postings instead of scanning every descriptor", () => {
    const descriptor = buildToolDescriptor(
      tool("needle_tool", "Find the needle"),
      "mcp",
      0
    );
    const index = buildToolRetrievalIndex([descriptor]);
    const withoutPostings = {
      ...index,
      postings: new Map<string, readonly number[]>(),
    };

    expect(searchToolRetrievalIndex(withoutPostings, "needle", 1)).toEqual([]);
  });

  test("bounds query bytes before tokenization", () => {
    const descriptor = buildToolDescriptor(
      tool("needle_tool", "Find the needle"),
      "mcp",
      0
    );
    const index = buildToolRetrievalIndex([descriptor]);

    expect(
      searchToolRetrievalIndex(index, `${"x".repeat(5_000)} needle`, 1)
    ).toEqual([]);
  });

  test("uses collision-safe identities for eligibility", () => {
    const left = buildToolDescriptor(tool("b/c", "shared"), "a", 0);
    const right = buildToolDescriptor(tool("c", "shared"), "a/b", 1);

    expect(left.key).not.toBe(right.key);
    expect(left.identityKey).toBe(toolIdentityKey("a", "b/c"));
    expect(right.identityKey).toBe(toolIdentityKey("a/b", "c"));
    const index = buildToolRetrievalIndex([left, right]);
    const matches = searchToolRetrievalIndex(
      index,
      "shared",
      2,
      new Set([left.identityKey])
    );

    expect(matches.map(({ descriptor }) => descriptor.mcpId)).toEqual(["a"]);
  });

  test.each([
    ["qualified mcp id", () => qualifiedToolKey("bad\ud800", "tool")],
    ["qualified tool name", () => qualifiedToolKey("mcp", "bad\udfff")],
    ["identity mcp id", () => toolIdentityKey("bad\ud800", "tool")],
    ["identity tool name", () => toolIdentityKey("mcp", "bad\udfff")],
  ])("fails malformed UTF-16 closed for %s", (_label, buildKey) => {
    expect(buildKey).toThrow("invalid UTF-16 string: unpaired surrogate");
  });

  test("keeps a valid astral surrogate pair reversible", () => {
    const mcpId = "mcp-🧭";
    const name = "提醒-💧";
    const qualified = qualifiedToolKey(mcpId, name);
    const [encodedMcpId, encodedName] = qualified.split("/");

    expect([
      decodeURIComponent(encodedMcpId!),
      decodeURIComponent(encodedName!),
    ]).toEqual([mcpId, name]);
    expect(JSON.parse(toolIdentityKey(mcpId, name))).toEqual([mcpId, name]);
  });

  test("keeps raw NUL-containing identity components injective", () => {
    const left = buildToolDescriptor(tool("c", "shared"), "a\u0000b", 0);
    const right = buildToolDescriptor(tool("b\u0000c", "shared"), "a", 1);
    const index = buildToolRetrievalIndex([left, right]);

    expect(left.identityKey).not.toBe(right.identityKey);
    const matches = searchToolRetrievalIndex(
      index,
      "shared",
      2,
      new Set([left.identityKey])
    );

    expect(matches.map(({ descriptor }) => descriptor.mcpId)).toEqual([
      "a\u0000b",
    ]);
  });

  test("computes relevance statistics over eligible descriptors only", () => {
    const first = buildToolDescriptor(tool("first", "needle"), "mcp", 0);
    const second = buildToolDescriptor(tool("second", "needle"), "mcp", 1);
    const eligible = new Set([first.identityKey, second.identityKey]);
    const base = searchToolRetrievalIndex(
      buildToolRetrievalIndex([first, second]),
      "needle",
      2,
      eligible
    );
    const ineligible = Array.from({ length: 20 }, (_, index) =>
      buildToolDescriptor(tool(`noise_${index}`, "needle"), "other", index + 2)
    );
    const expanded = searchToolRetrievalIndex(
      buildToolRetrievalIndex([first, second, ...ineligible]),
      "needle",
      2,
      eligible
    );

    expect(expanded.map(({ descriptor }) => descriptor.name)).toEqual(
      base.map(({ descriptor }) => descriptor.name)
    );
    expect(expanded.map(({ totalScore }) => totalScore)).toEqual(
      base.map(({ totalScore }) => totalScore)
    );

    const baseLinear = searchToolRetrievalIndex(
      buildToolRetrievalIndex([first, second], { maxIndexBytes: 1 }),
      "needle",
      2,
      eligible
    );
    const expandedLinear = searchToolRetrievalIndex(
      buildToolRetrievalIndex([first, second, ...ineligible], {
        maxIndexBytes: 1,
      }),
      "needle",
      2,
      eligible
    );
    expect(expandedLinear.map(({ totalScore }) => totalScore)).toEqual(
      baseLinear.map(({ totalScore }) => totalScore)
    );
  });

  test("freezes compact searchable snapshots independently of source tools", () => {
    const source = tool("search_students", "Original description", {
      email: { type: "string", description: "Original email" },
    });
    const descriptor = buildToolDescriptor(source, "school", 0);
    const index = buildToolRetrievalIndex([descriptor]);
    source.description = "Mutated description";
    (
      (
        source.inputSchema?.properties as Record<
          string,
          { description: string }
        >
      ).email as { description: string }
    ).description = "Mutated email";

    expect(index.descriptors[0]?.description).toBe("Original description");
    expect(index.descriptors[0]?.parameterDescriptions).toEqual([
      "Original email",
    ]);
    expect(index.descriptors[0]).not.toHaveProperty("tool");
    expect(Object.isFrozen(index.descriptors[0])).toBe(true);
    expect(Object.isFrozen(index.descriptors[0]?.parameterDescriptions)).toBe(
      true
    );
  });

  test("does not retain a huge non-searchable tool schema in the index", () => {
    const source = tool("compact_tool", "Compact searchable description", {
      payload: {
        type: "string",
        description: "Small searchable parameter description",
        examples: ["x".repeat(17 * 1024 * 1024)],
      },
    });
    const index = buildToolRetrievalIndex([
      buildToolDescriptor(source, "large-schema-mcp", 0),
    ]);

    expect(index.mode).toBe("inverted");
    expect(index.estimatedBytes).toBeLessThan(16 * 1024 * 1024);
    expect(index.descriptors[0]).not.toHaveProperty("tool");
  });
});

describe("tool router retrieval integration", () => {
  test("routes generic parameter semantics through the public contract", () => {
    const entries = [
      catalogEntryForTool(tool("list_courses", "List courses"), 0, "school"),
      catalogEntryForTool(
        tool("search_students", "Search students", {
          email: { type: "string", description: "學員電子郵件" },
        }),
        1,
        "school"
      ),
    ];

    const route = routeToolEntries({
      entries,
      message: "用 email 查學員",
      budget: 1,
      reservedEntries: [],
    });

    expect(route.selectedEntries[0]?.name).toBe("search_students");
    expect(route.fallback).toBeNull();
  });

  test("reuses inventory only while applying authorization per turn", () => {
    clearToolRetrievalIndexCacheForTests();
    const entries = [
      catalogEntryForTool(tool("list_courses", "List courses"), 0, "school"),
      catalogEntryForTool(
        tool("search_students", "Search students", {
          email: { type: "string", description: "學員電子郵件" },
        }),
        1,
        "school"
      ),
    ];
    const first = routeToolEntries({
      entries,
      message: "用 email 查學員",
      budget: 1,
      reservedEntries: [],
      allowedToolNames: ["school/search_students"],
    });
    const second = routeToolEntries({
      entries,
      message: "用 email 查學員",
      budget: 1,
      reservedEntries: [],
      allowedToolNames: ["school/list_courses"],
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.estimatedIndexBytes).toBeGreaterThan(0);
    expect(second.cacheEvictionCount).toBe(0);
    expect(second.selectedEntries).toEqual([]);
    expect(second.candidates).toEqual([]);
  });

  test("invalidates warmed route indexes after source mutation or order change", () => {
    clearToolRetrievalIndexCacheForTests();
    const alpha = tool("alpha_search", "Find alpha records");
    const beta = tool("beta_search", "Find beta records");
    const entries = [
      catalogEntryForTool(alpha, 0, "school"),
      catalogEntryForTool(beta, 1, "school"),
    ];
    const route = (inventory: typeof entries) =>
      routeToolEntries({
        entries: inventory,
        message: "Find records",
        budget: 2,
        reservedEntries: [],
      });

    const initial = route(entries);
    alpha.description = "Find changed alpha records";
    const mutated = route(entries);
    const reordered = route([...entries].reverse());

    expect(mutated.cacheHit).toBe(false);
    expect(mutated.inventoryFingerprint).not.toBe(initial.inventoryFingerprint);
    expect(reordered.cacheHit).toBe(false);
    expect(reordered.inventoryFingerprint).not.toBe(
      mutated.inventoryFingerprint
    );
  });
});
