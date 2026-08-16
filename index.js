import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerTranslatorReplyMap } from "./core.js";

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ownerChatId", "partnerChatId"],
  properties: {
    ownerChatId: { type: "string", pattern: "^-?[0-9]{5,20}$" },
    partnerChatId: { type: "string", pattern: "^-?[0-9]{5,20}$" },
    agentId: { type: "string", default: "translator" },
    accountId: { type: "string", default: "translator" },
    stateDir: { type: "string" },
    mediaLocalRoots: { type: "array", items: { type: "string" }, default: [] },
  },
};

export default definePluginEntry({
  id: "translator-reply-map",
  name: "Translator Reply Map",
  description: "Native Telegram reply routing for a two-party OpenClaw translator.",
  configSchema,
  register: registerTranslatorReplyMap,
});
