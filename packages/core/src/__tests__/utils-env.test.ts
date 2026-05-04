import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError } from "../errors";
import {
  getOptionalBoolean,
  getOptionalEnv,
  getOptionalNumber,
  getRequiredEnv,
} from "../utils/env";

const TEST_KEY = "__LOBU_TEST_ENV_KEY__";

describe("env utilities", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[TEST_KEY];
    delete process.env[TEST_KEY];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[TEST_KEY];
    } else {
      process.env[TEST_KEY] = original;
    }
  });

  describe("getRequiredEnv", () => {
    test("returns the env value when set", () => {
      process.env[TEST_KEY] = "hello";
      expect(getRequiredEnv(TEST_KEY)).toBe("hello");
    });

    test("throws ConfigError when env is not set", () => {
      expect(() => getRequiredEnv(TEST_KEY)).toThrow(ConfigError);
      expect(() => getRequiredEnv(TEST_KEY)).toThrow(
        `Missing required environment variable: ${TEST_KEY}`
      );
    });

    test("throws ConfigError when env is empty string", () => {
      process.env[TEST_KEY] = "";
      expect(() => getRequiredEnv(TEST_KEY)).toThrow(ConfigError);
    });
  });

  describe("getOptionalEnv", () => {
    test("returns env value when set", () => {
      process.env[TEST_KEY] = "value";
      expect(getOptionalEnv(TEST_KEY, "default")).toBe("value");
    });

    test("returns default when env not set", () => {
      expect(getOptionalEnv(TEST_KEY, "default")).toBe("default");
    });

    test("returns default when env is empty string (uses ||)", () => {
      process.env[TEST_KEY] = "";
      expect(getOptionalEnv(TEST_KEY, "fallback")).toBe("fallback");
    });

    test("returns undefined when no default provided and env not set", () => {
      expect(getOptionalEnv(TEST_KEY)).toBeUndefined();
    });
  });

  describe("getOptionalNumber", () => {
    test("returns parsed integer when set", () => {
      process.env[TEST_KEY] = "42";
      expect(getOptionalNumber(TEST_KEY, 10)).toBe(42);
    });

    test("returns default when env not set", () => {
      expect(getOptionalNumber(TEST_KEY, 7)).toBe(7);
    });

    test("returns default when env is empty string", () => {
      process.env[TEST_KEY] = "";
      expect(getOptionalNumber(TEST_KEY, 5)).toBe(5);
    });

    test("throws ConfigError on non-numeric value", () => {
      process.env[TEST_KEY] = "not-a-number";
      expect(() => getOptionalNumber(TEST_KEY, 0)).toThrow(ConfigError);
      expect(() => getOptionalNumber(TEST_KEY, 0)).toThrow(
        `Invalid number for ${TEST_KEY}`
      );
    });

    test("parses numbers with leading garbage as NaN-safe via parseInt", () => {
      // parseInt("123abc", 10) === 123 — documenting current behavior
      process.env[TEST_KEY] = "123abc";
      expect(getOptionalNumber(TEST_KEY, 0)).toBe(123);
    });

    test("handles negative numbers", () => {
      process.env[TEST_KEY] = "-99";
      expect(getOptionalNumber(TEST_KEY, 0)).toBe(-99);
    });
  });

  describe("getOptionalBoolean", () => {
    test("returns true for 'true' (case-insensitive)", () => {
      for (const v of ["true", "TRUE", "True"]) {
        process.env[TEST_KEY] = v;
        expect(getOptionalBoolean(TEST_KEY, false)).toBe(true);
      }
    });

    test("returns true for '1' and 'yes'", () => {
      process.env[TEST_KEY] = "1";
      expect(getOptionalBoolean(TEST_KEY, false)).toBe(true);
      process.env[TEST_KEY] = "yes";
      expect(getOptionalBoolean(TEST_KEY, false)).toBe(true);
      process.env[TEST_KEY] = "YES";
      expect(getOptionalBoolean(TEST_KEY, false)).toBe(true);
    });

    test("returns false for unrecognized truthy-looking strings", () => {
      process.env[TEST_KEY] = "false";
      expect(getOptionalBoolean(TEST_KEY, true)).toBe(false);
      process.env[TEST_KEY] = "0";
      expect(getOptionalBoolean(TEST_KEY, true)).toBe(false);
      process.env[TEST_KEY] = "no";
      expect(getOptionalBoolean(TEST_KEY, true)).toBe(false);
      process.env[TEST_KEY] = "anything-else";
      expect(getOptionalBoolean(TEST_KEY, true)).toBe(false);
    });

    test("returns default when env not set", () => {
      expect(getOptionalBoolean(TEST_KEY, true)).toBe(true);
      expect(getOptionalBoolean(TEST_KEY, false)).toBe(false);
    });

    test("returns default when env is empty string", () => {
      process.env[TEST_KEY] = "";
      expect(getOptionalBoolean(TEST_KEY, true)).toBe(true);
    });
  });
});
