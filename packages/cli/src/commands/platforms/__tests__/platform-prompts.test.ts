import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const passwordResponses: string[] = [];
const inputResponses: string[] = [];

const passwordMock = mock(async () => {
  if (passwordResponses.length === 0) {
    throw new Error("password() called more times than the test queued");
  }
  return passwordResponses.shift()!;
});
const inputMock = mock(async () => {
  if (inputResponses.length === 0) {
    throw new Error("input() called more times than the test queued");
  }
  return inputResponses.shift()!;
});

mock.module("@inquirer/prompts", () => ({
  password: passwordMock,
  input: inputMock,
}));

const originalLog = console.log;

let promptPlatformConfig: typeof import("../platform-prompts").promptPlatformConfig;
let PLATFORM_LABELS: typeof import("../platform-prompts").PLATFORM_LABELS;

beforeAll(async () => {
  console.log = () => undefined;
  ({ promptPlatformConfig, PLATFORM_LABELS } = await import(
    "../platform-prompts"
  ));
});

afterAll(() => {
  console.log = originalLog;
});

beforeEach(() => {
  passwordResponses.length = 0;
  inputResponses.length = 0;
  passwordMock.mockClear();
  inputMock.mockClear();
});

/**
 * Each row defines a platform's full prompt contract. Tests then verify three
 * properties from a single source of truth:
 *   1. Filled inputs produce the expected env-var refs in `platformConfig`.
 *   2. The matching `platformSecrets` entries are emitted with verbatim values.
 *   3. Empty inputs produce empty config and empty secrets (skip-on-blank).
 *
 * `passwords` and `inputs` are queued in the order the source code prompts.
 * `expectedConfig` keys mirror the source's `platformConfig.<key> = "$ENV"`
 * lines, so changing a key/env-var in the source forces a deliberate edit
 * here.
 */
type PromptKind = "password" | "input";
interface FieldSpec {
  kind: PromptKind;
  /** Test value to feed when the prompt is called. */
  value: string;
  /** Expected key in `platformConfig`. */
  configKey: string;
  /** Expected env-var name in `platformSecrets`. */
  envVar: string;
}
interface PlatformCase {
  platform: string;
  fields: FieldSpec[];
}

const PLATFORM_CASES: PlatformCase[] = [
  {
    platform: "telegram",
    fields: [
      {
        kind: "password",
        value: "tg-secret",
        configKey: "botToken",
        envVar: "TELEGRAM_BOT_TOKEN",
      },
    ],
  },
  {
    platform: "slack",
    fields: [
      {
        kind: "password",
        value: "xoxb-abc",
        configKey: "botToken",
        envVar: "SLACK_BOT_TOKEN",
      },
      {
        kind: "password",
        value: "signing-xyz",
        configKey: "signingSecret",
        envVar: "SLACK_SIGNING_SECRET",
      },
    ],
  },
  {
    platform: "discord",
    fields: [
      {
        kind: "password",
        value: "disc-token",
        configKey: "botToken",
        envVar: "DISCORD_BOT_TOKEN",
      },
    ],
  },
  {
    platform: "whatsapp",
    fields: [
      {
        kind: "password",
        value: "wa-access",
        configKey: "accessToken",
        envVar: "WHATSAPP_ACCESS_TOKEN",
      },
      {
        kind: "input",
        value: "12345",
        configKey: "phoneNumberId",
        envVar: "WHATSAPP_PHONE_NUMBER_ID",
      },
    ],
  },
  {
    platform: "teams",
    fields: [
      {
        kind: "input",
        value: "app-id-1",
        configKey: "appId",
        envVar: "TEAMS_APP_ID",
      },
      {
        kind: "password",
        value: "app-pwd-1",
        configKey: "appPassword",
        envVar: "TEAMS_APP_PASSWORD",
      },
    ],
  },
  {
    platform: "gchat",
    fields: [
      {
        kind: "password",
        value: '{"type":"service_account"}',
        configKey: "credentials",
        envVar: "GOOGLE_CHAT_CREDENTIALS",
      },
    ],
  },
];

function queue(field: FieldSpec) {
  if (field.kind === "password") passwordResponses.push(field.value);
  else inputResponses.push(field.value);
}

function expectedFromFields(fields: FieldSpec[]) {
  const platformConfig: Record<string, string> = {};
  const platformSecrets: Array<{ envVar: string; value: string }> = [];
  for (const f of fields) {
    if (!f.value) continue;
    platformConfig[f.configKey] = `$${f.envVar}`;
    platformSecrets.push({ envVar: f.envVar, value: f.value });
  }
  return { platformConfig, platformSecrets };
}

test("PLATFORM_LABELS lists every platform with a prompt branch", () => {
  for (const { platform } of PLATFORM_CASES) {
    expect(PLATFORM_LABELS[platform]).toBeTruthy();
  }
});

test("returns empty config for unknown platforms without prompting", async () => {
  const result = await promptPlatformConfig("unknown");
  expect(result.platformConfig).toEqual({});
  expect(result.platformSecrets).toEqual([]);
  expect(passwordMock).not.toHaveBeenCalled();
  expect(inputMock).not.toHaveBeenCalled();
});

describe("promptPlatformConfig — happy path (all fields filled)", () => {
  for (const c of PLATFORM_CASES) {
    test(c.platform, async () => {
      for (const f of c.fields) queue(f);
      const result = await promptPlatformConfig(c.platform);
      expect(result).toEqual(expectedFromFields(c.fields));
    });
  }
});

describe("promptPlatformConfig — every field blank produces empty result", () => {
  for (const c of PLATFORM_CASES) {
    test(c.platform, async () => {
      for (const f of c.fields) queue({ ...f, value: "" });
      const result = await promptPlatformConfig(c.platform);
      expect(result.platformConfig).toEqual({});
      expect(result.platformSecrets).toEqual([]);
    });
  }
});

describe("promptPlatformConfig — partial blanks omit only the empty fields", () => {
  // Only run for multi-field platforms; single-field platforms are covered
  // by the all-blank case above.
  for (const c of PLATFORM_CASES.filter((c) => c.fields.length > 1)) {
    test(`${c.platform} — first field blank, rest filled`, async () => {
      const blanked = c.fields.map((f, i) =>
        i === 0 ? { ...f, value: "" } : f
      );
      for (const f of blanked) queue(f);
      const result = await promptPlatformConfig(c.platform);
      expect(result).toEqual(expectedFromFields(blanked));
    });
  }
});
