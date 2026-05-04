import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createLogger, logger as defaultLogger } from "../logger";

const ENV_KEYS = [
  "USE_WINSTON_LOGGER",
  "LOG_FORMAT",
  "LOG_LEVEL",
  "NODE_ENV",
  "SENTRY_DSN",
] as const;

describe("createLogger (console-based default)", () => {
  let saved: Record<string, string | undefined> = {};
  let consoleErrorSpy: ReturnType<typeof mock>;
  let consoleWarnSpy: ReturnType<typeof mock>;
  let consoleLogSpy: ReturnType<typeof mock>;
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;
  let originalLog: typeof console.log;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    originalError = console.error;
    originalWarn = console.warn;
    originalLog = console.log;

    consoleErrorSpy = mock(() => undefined);
    consoleWarnSpy = mock(() => undefined);
    consoleLogSpy = mock(() => undefined);

    console.error = consoleErrorSpy as unknown as typeof console.error;
    console.warn = consoleWarnSpy as unknown as typeof console.warn;
    console.log = consoleLogSpy as unknown as typeof console.log;
  });

  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
    console.log = originalLog;

    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  test("returns a logger object with all four log methods", () => {
    const log = createLogger("test-service");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  test("default logger export is also a Logger", () => {
    expect(typeof defaultLogger.error).toBe("function");
    expect(typeof defaultLogger.warn).toBe("function");
    expect(typeof defaultLogger.info).toBe("function");
    expect(typeof defaultLogger.debug).toBe("function");
  });

  test("info() writes via console.log when level is info (default)", () => {
    const log = createLogger("svc");
    log.info("hello world");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const call = (consoleLogSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("[info]");
    expect(call).toContain("[svc]");
    expect(call).toContain("hello world");
  });

  test("warn() writes via console.warn", () => {
    const log = createLogger("svc");
    log.warn("a warning");
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const call = (consoleWarnSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("[warn]");
    expect(call).toContain("a warning");
  });

  test("error() writes via console.error", () => {
    const log = createLogger("svc");
    log.error("boom");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const call = (consoleErrorSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("[error]");
    expect(call).toContain("boom");
  });

  test("debug() is suppressed at default (info) level", () => {
    const log = createLogger("svc");
    log.debug("noisy");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test("LOG_LEVEL=error suppresses warn/info/debug", () => {
    process.env.LOG_LEVEL = "error";
    const log = createLogger("svc");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test("LOG_LEVEL=debug enables every level", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger("svc");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    // info + debug both go to console.log
    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
  });

  test("LOG_LEVEL=warn allows error+warn but blocks info/debug", () => {
    process.env.LOG_LEVEL = "warn";
    const log = createLogger("svc");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test("unknown LOG_LEVEL falls back to info threshold", () => {
    process.env.LOG_LEVEL = "totally-bogus";
    const log = createLogger("svc");
    log.info("i");
    log.debug("d");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1); // only info
  });

  test("formatted line includes ISO-ish timestamp prefix", () => {
    const log = createLogger("svc");
    log.info("ping");
    const call = (consoleLogSpy.mock.calls[0] ?? [])[0] as string;
    // [YYYY-MM-DD HH:MM:SS] prefix
    expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });

  test("pino-style call with metadata object first puts message + meta in output", () => {
    const log = createLogger("svc");
    log.info({ userId: "u1", count: 3 }, "user action");
    const call = (consoleLogSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("user action");
    expect(call).toContain("u1");
    expect(call).toContain('"count":3');
  });

  test("plain object as message is JSON-stringified", () => {
    const log = createLogger("svc");
    log.info({ key: "value" });
    const call = (consoleLogSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain('"key":"value"');
  });

  test("string message + extra args appends serialized args", () => {
    const log = createLogger("svc");
    log.info("event", { foo: 1 });
    const call = (consoleLogSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("event");
    expect(call).toContain('"foo":1');
  });

  test("string message with multiple extra args is serialized as an array", () => {
    const log = createLogger("svc");
    log.info("multi", "a", "b");
    const call = (consoleLogSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("multi");
    expect(call).toContain('["a","b"]');
  });

  test("circular metadata object falls back without throwing", () => {
    const log = createLogger("svc");
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    expect(() => log.info(circ, "circular!")).not.toThrow();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const call = (consoleLogSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("circular!");
  });

  test("Error objects don't crash and are stringified", () => {
    const log = createLogger("svc");
    expect(() => log.error(new Error("kaboom"))).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const call = (consoleErrorSpy.mock.calls[0] ?? [])[0] as string;
    expect(call).toContain("kaboom");
  });

  test("each createLogger call yields an independent logger (acts as a child logger by name)", () => {
    const a = createLogger("alpha");
    const b = createLogger("beta");
    a.info("x");
    b.info("y");
    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    const lines = consoleLogSpy.mock.calls.map((c) => (c ?? [])[0] as string);
    expect(lines.some((l) => l.includes("[alpha]") && l.includes("x"))).toBe(
      true
    );
    expect(lines.some((l) => l.includes("[beta]") && l.includes("y"))).toBe(
      true
    );
  });
});
