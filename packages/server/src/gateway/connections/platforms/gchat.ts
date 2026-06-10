/**
 * Google Chat capability descriptor. No file handler yet; routing extraction
 * keeps the legacy WhatsApp-shape fallthrough (see
 * `extractWhatsAppStyleRoutingInfo`).
 */

import { extractWhatsAppStyleRoutingInfo } from "./shared.js";
import type { ChatPlatformDescriptor } from "./types.js";

export const gchatPlatform: ChatPlatformDescriptor = {
  // Pre-existing lazy adapter factory, moved verbatim from the manager's
  // ADAPTER_FACTORIES map (adapter SDKs stay lazy-loaded per platform).
  createAdapter: async (c) =>
    (await import("@chat-adapter/gchat")).createGoogleChatAdapter(c),

  extractRoutingInfo: extractWhatsAppStyleRoutingInfo,
};
