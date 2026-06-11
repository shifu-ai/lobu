/**
 * Utilities shared by per-platform capability modules. All of these moved out
 * of `ChatInstanceManager` verbatim so each platform descriptor can compose
 * them without re-importing the manager.
 */

import type { Readable } from "node:stream";
import type { IFileHandler } from "../../platform/file-handler.js";
import type { ChatPlatformInstance, PlatformRoutingInfo } from "./types.js";

/** Drain a Readable into a single Buffer. */
export async function streamToBuffer(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Post a Postable (carrying a file buffer) to a thread or channel on a
 * managed Chat instance. Shared by every Chat-SDK-backed file handler
 * (Slack, Discord, Teams). `threadId` / `channelKey` are already the
 * canonical platform-prefixed ids the Chat SDK expects.
 */
export async function postFileToChatTarget(
  instance: ChatPlatformInstance,
  target: { threadId?: string; channelKey: string },
  postable: { raw: string; files: Array<{ data: Buffer; filename: string }> }
): Promise<any> {
  const { chat } = instance;
  const platform = instance.connection.platform;

  if (target.threadId) {
    const adapter = chat.getAdapter?.(platform);
    const createThread = (chat as any).createThread;
    if (!adapter || typeof createThread !== "function") {
      throw new Error(`Chat instance has no createThread for ${platform}`);
    }
    // `undefined` (not `{}`) — empty object makes Chat SDK crash in
    // handleStream reading `_currentMessage.author.userId`.
    const thread = await createThread.call(
      chat,
      adapter,
      target.threadId,
      undefined,
      false
    );
    if (!thread) {
      throw new Error(
        `Unable to resolve ${platform} thread ${target.threadId} for upload`
      );
    }
    return thread.post(postable);
  }

  const channel = chat.channel?.(target.channelKey);
  if (!channel) {
    throw new Error(
      `Unable to resolve ${platform} channel ${target.channelKey} for upload`
    );
  }
  return channel.post(postable);
}

// Generic file handler for platforms whose Chat SDK adapter already supports
// Postable.files (Discord, Teams). The conversationId arriving as `threadTs`
// is the canonical platform-prefixed thread ID (e.g. `discord:guildId:channelId`).
export function createChatSdkFileHandler(
  instance: ChatPlatformInstance
): IFileHandler {
  const platform = instance.connection.platform;

  return {
    uploadFile: async (fileStream, options) => {
      const buffer = await streamToBuffer(fileStream);
      const sent = await postFileToChatTarget(
        instance,
        {
          threadId: options.threadTs,
          channelKey: `${platform}:${options.channelId}`,
        },
        {
          raw: options.initialComment || "",
          files: [{ data: buffer, filename: options.filename }],
        }
      );

      return {
        fileId: String(sent?.id || sent?.messageId || sent?.ts || Date.now()),
        permalink: "",
        name: options.filename,
        size: buffer.length,
      };
    },
  };
}

/**
 * Legacy routing-info fallback: before the capability registry existed,
 * `extractPlatformRoutingInfo` fell through to the WhatsApp body shape
 * (`body.whatsapp.chat`) for every platform that wasn't Slack or Telegram.
 * Discord/Teams/GChat keep that exact behavior by pointing their descriptors
 * here alongside WhatsApp itself.
 */
export function extractWhatsAppStyleRoutingInfo(
  body: Record<string, unknown>
): PlatformRoutingInfo | null {
  const whatsapp = body.whatsapp as { chat?: string } | undefined;
  if (!whatsapp?.chat) return null;
  return {
    channelId: whatsapp.chat,
    conversationId: whatsapp.chat,
  };
}
