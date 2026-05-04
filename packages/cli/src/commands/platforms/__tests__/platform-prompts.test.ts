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
  // Silence console.log noise from the Slack onboarding instructions.
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

describe("PLATFORM_LABELS", () => {
  test("includes all built-in platforms", () => {
    expect(PLATFORM_LABELS.telegram).toBe("Telegram");
    expect(PLATFORM_LABELS.slack).toBe("Slack");
    expect(PLATFORM_LABELS.discord).toBe("Discord");
    expect(PLATFORM_LABELS.whatsapp).toBe("WhatsApp");
    expect(PLATFORM_LABELS.teams).toBe("Microsoft Teams");
    expect(PLATFORM_LABELS.gchat).toBe("Google Chat");
  });
});

describe("promptPlatformConfig", () => {
  test("returns empty config for unknown platforms without prompting", async () => {
    const result = await promptPlatformConfig("unknown");

    expect(result.platformConfig).toEqual({});
    expect(result.platformSecrets).toEqual([]);
    expect(passwordMock).not.toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();
  });

  test("telegram captures bot token into a $TELEGRAM_BOT_TOKEN env reference", async () => {
    passwordResponses.push("tg-secret");

    const { platformConfig, platformSecrets } =
      await promptPlatformConfig("telegram");

    expect(platformConfig).toEqual({ botToken: "$TELEGRAM_BOT_TOKEN" });
    expect(platformSecrets).toEqual([
      { envVar: "TELEGRAM_BOT_TOKEN", value: "tg-secret" },
    ]);
  });

  test("telegram skips config when token is empty", async () => {
    passwordResponses.push("");

    const { platformConfig, platformSecrets } =
      await promptPlatformConfig("telegram");

    expect(platformConfig).toEqual({});
    expect(platformSecrets).toEqual([]);
  });

  test("slack captures bot token + signing secret", async () => {
    passwordResponses.push("xoxb-abc", "signing-xyz");

    const { platformConfig, platformSecrets } =
      await promptPlatformConfig("slack");

    expect(platformConfig).toEqual({
      botToken: "$SLACK_BOT_TOKEN",
      signingSecret: "$SLACK_SIGNING_SECRET",
    });
    expect(platformSecrets).toEqual([
      { envVar: "SLACK_BOT_TOKEN", value: "xoxb-abc" },
      { envVar: "SLACK_SIGNING_SECRET", value: "signing-xyz" },
    ]);
  });

  test("slack omits each value independently when blank", async () => {
    passwordResponses.push("", "signing-only");

    const { platformConfig, platformSecrets } =
      await promptPlatformConfig("slack");

    expect(platformConfig).toEqual({
      signingSecret: "$SLACK_SIGNING_SECRET",
    });
    expect(platformSecrets).toEqual([
      { envVar: "SLACK_SIGNING_SECRET", value: "signing-only" },
    ]);
  });

  test("discord captures bot token", async () => {
    passwordResponses.push("disc-token");

    const result = await promptPlatformConfig("discord");

    expect(result.platformConfig).toEqual({ botToken: "$DISCORD_BOT_TOKEN" });
    expect(result.platformSecrets).toEqual([
      { envVar: "DISCORD_BOT_TOKEN", value: "disc-token" },
    ]);
  });

  test("whatsapp captures access token + phone number id", async () => {
    passwordResponses.push("wa-access");
    inputResponses.push("12345");

    const result = await promptPlatformConfig("whatsapp");

    expect(result.platformConfig).toEqual({
      accessToken: "$WHATSAPP_ACCESS_TOKEN",
      phoneNumberId: "$WHATSAPP_PHONE_NUMBER_ID",
    });
    expect(result.platformSecrets).toEqual([
      { envVar: "WHATSAPP_ACCESS_TOKEN", value: "wa-access" },
      { envVar: "WHATSAPP_PHONE_NUMBER_ID", value: "12345" },
    ]);
  });

  test("whatsapp omits empty fields", async () => {
    passwordResponses.push("");
    inputResponses.push("");

    const result = await promptPlatformConfig("whatsapp");

    expect(result.platformConfig).toEqual({});
    expect(result.platformSecrets).toEqual([]);
  });

  test("teams captures app id + app password", async () => {
    inputResponses.push("app-id-1");
    passwordResponses.push("app-pwd-1");

    const result = await promptPlatformConfig("teams");

    expect(result.platformConfig).toEqual({
      appId: "$TEAMS_APP_ID",
      appPassword: "$TEAMS_APP_PASSWORD",
    });
    expect(result.platformSecrets).toEqual([
      { envVar: "TEAMS_APP_ID", value: "app-id-1" },
      { envVar: "TEAMS_APP_PASSWORD", value: "app-pwd-1" },
    ]);
  });

  test("gchat captures service-account credentials", async () => {
    passwordResponses.push('{"type":"service_account"}');

    const result = await promptPlatformConfig("gchat");

    expect(result.platformConfig).toEqual({
      credentials: "$GOOGLE_CHAT_CREDENTIALS",
    });
    expect(result.platformSecrets).toEqual([
      {
        envVar: "GOOGLE_CHAT_CREDENTIALS",
        value: '{"type":"service_account"}',
      },
    ]);
  });

  test("gchat skips when credentials are empty", async () => {
    passwordResponses.push("");

    const result = await promptPlatformConfig("gchat");

    expect(result.platformConfig).toEqual({});
    expect(result.platformSecrets).toEqual([]);
  });
});
