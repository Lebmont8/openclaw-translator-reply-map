import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ID = "translator-reply-map";
const TOOL_NAME = "translator_send";
const SHARED_RUNTIME_KEY = Symbol.for("openclaw.translator-reply-map.runtime.v3");
const MAX_ENTRIES = 5000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INBOUND_AGE_MS = 10 * 60 * 1000;
const FALLBACK_QUOTE_LIMIT = 180;

const DEFAULT_STATE_DIR = path.join(
  process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"),
  "translator-reply-map",
);

let settings = {
  agentId: "translator",
  accountId: "translator",
  ownerChatId: "100000001",
  partnerChatId: "100000002",
  stateDir: DEFAULT_STATE_DIR,
  mediaLocalRoots: [],
};

export function configureTranslatorReplyMap(raw = {}) {
  const next = {
    agentId: String(raw.agentId || "translator"),
    accountId: String(raw.accountId || "translator"),
    ownerChatId: String(raw.ownerChatId || "").trim(),
    partnerChatId: String(raw.partnerChatId || "").trim(),
    stateDir: String(raw.stateDir || DEFAULT_STATE_DIR),
    mediaLocalRoots: Array.isArray(raw.mediaLocalRoots) ? raw.mediaLocalRoots.map(String) : [],
  };
  if (!next.ownerChatId || !next.partnerChatId || next.ownerChatId === next.partnerChatId) {
    throw new Error("ownerChatId and partnerChatId must be distinct Telegram IDs");
  }
  settings = next;
  delete globalThis[SHARED_RUNTIME_KEY];
  return settings;
}

function allowedChatIds() {
  return new Set([settings.ownerChatId, settings.partnerChatId]);
}

function statePath(name) {
  return path.join(settings.stateDir, name);
}

function translatorSendParameters() {
  return {
  type: "object",
  additionalProperties: false,
  required: ["target"],
  properties: {
    target: {
      type: "string",
      enum: [settings.ownerChatId, settings.partnerChatId],
      description:
        `Telegram user ID of the other participant. Target ${settings.ownerChatId} accepts Russian translations; target ${settings.partnerChatId} accepts English translations.`,
    },
    message: {
      type: "string",
      description: "Translated text to send when there is no media.",
    },
    media: {
      type: "string",
      description: "Inbound local media path or supported media URL to forward unchanged.",
    },
    caption: {
      type: "string",
      description: "Translated caption for the forwarded media.",
    },
    asVoice: {
      type: "boolean",
      default: false,
      description: "Send compatible audio media as a Telegram voice message.",
    },
    forceDocument: {
      type: "boolean",
      default: false,
      description: "Send media as a Telegram document.",
    },
  },
  };
}

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  };
}

function normalizeId(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeChatId(value) {
  const normalized = normalizeId(value);
  if (!normalized) return undefined;
  return normalized.replace(/^(?:telegram:|chat:|user:)/, "");
}

function stripLanguageNeutralFragments(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, " ")
    .replace(/@[\p{L}\p{N}_]+/gu, " ");
}

function hasLatin(value) {
  return /\p{Script=Latin}/u.test(stripLanguageNeutralFragments(value));
}

function hasCyrillic(value) {
  return /\p{Script=Cyrillic}/u.test(stripLanguageNeutralFragments(value));
}

export function detectTargetLanguageMismatch({ sourceChatId, sourceText, outputText }) {
  if (!sourceText || !outputText) return undefined;
  if (sourceChatId === settings.partnerChatId && hasLatin(sourceText) && !hasCyrillic(outputText)) {
    return { expectedLanguage: "Russian", target: settings.ownerChatId };
  }
  if (sourceChatId === settings.ownerChatId && hasCyrillic(sourceText) && !hasLatin(outputText)) {
    return { expectedLanguage: "English", target: settings.partnerChatId };
  }
  return undefined;
}

function mapKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

export function parseTranslatorSessionKey(sessionKey) {
  const prefix = `agent:${settings.agentId}:telegram:${settings.accountId}:direct:`;
  const value = String(sessionKey || "");
  if (!value.startsWith(prefix)) return null;
  const peerId = normalizeId(value.slice(prefix.length));
  if (!peerId || peerId.includes(":") || !allowedChatIds().has(peerId)) return null;
  return { peerId };
}

function truncateQuote(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length <= FALLBACK_QUOTE_LIMIT
    ? compact
    : `${compact.slice(0, FALLBACK_QUOTE_LIMIT - 1)}…`;
}

function addFallbackQuote(params, body) {
  const quote = truncateQuote(body);
  if (!quote) return params;
  const next = { ...params };
  const prefix = `↪ ${quote}\n\n`;
  if (typeof next.message === "string" && next.message) {
    next.message = `${prefix}${next.message}`;
  } else if (typeof next.caption === "string" && next.caption) {
    next.caption = `${prefix}${next.caption}`;
  } else if (next.media) {
    next.caption = `↪ ${quote}`;
  }
  return next;
}

export function extractMessageId(value, depth = 0) {
  if (depth > 6 || value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.length > 20_000) return undefined;
    const trimmed = value.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
    try {
      return extractMessageId(JSON.parse(trimmed), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractMessageId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  for (const key of ["messageId", "message_id"]) {
    const found = normalizeId(value[key]);
    if (found) return found;
  }
  for (const key of ["details", "result", "data", "content", "text"]) {
    const found = extractMessageId(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

export class ReplyMapStore {
  constructor(statePathValue = statePath("reply-map.json"), now = () => Date.now()) {
    this.statePath = statePathValue;
    this.now = now;
    this.entries = new Map();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      for (const [key, value] of Object.entries(parsed.entries || {})) {
        if (
          normalizeId(value?.peerChatId) &&
          normalizeId(value?.peerMessageId) &&
          Number.isFinite(value?.createdAt)
        ) {
          this.entries.set(key, value);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.prune();
  }

  prune() {
    const cutoff = this.now() - MAX_AGE_MS;
    for (const [key, value] of this.entries) {
      if (value.createdAt < cutoff) this.entries.delete(key);
    }
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    for (const [key] of oldest.slice(0, this.entries.size - MAX_ENTRIES)) {
      this.entries.delete(key);
    }
  }

  get(chatId, messageId) {
    this.load();
    return this.entries.get(mapKey(chatId, messageId));
  }

  async link(sourceChatId, sourceMessageId, targetChatId, targetMessageId) {
    this.load();
    const createdAt = this.now();
    const sourceKey = mapKey(sourceChatId, sourceMessageId);
    const targetKey = mapKey(targetChatId, targetMessageId);

    if (!this.entries.has(sourceKey)) {
      this.entries.set(sourceKey, {
        peerChatId: targetChatId,
        peerMessageId: targetMessageId,
        createdAt,
      });
    }
    this.entries.set(targetKey, {
      peerChatId: sourceChatId,
      peerMessageId: sourceMessageId,
      createdAt,
    });
    this.prune();
    await this.persist();
  }

  async persist() {
    const payload = JSON.stringify(
      { version: 1, entries: Object.fromEntries(this.entries) },
      null,
      2,
    );
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
      const tempPath = `${this.statePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tempPath, payload, { mode: 0o600 });
      await fs.promises.rename(tempPath, this.statePath);
    });
    return this.writeQueue;
  }
}

export class InboundContextStore {
  constructor(statePathValue = statePath("reply-inbound.json"), now = () => Date.now()) {
    this.statePath = statePathValue;
    this.now = now;
    this.memory = new Map();
  }

  readRecords() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return parsed?.records && typeof parsed.records === "object"
        ? parsed.records
        : {};
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }

  capture(record) {
    this.memory.set(record.sourceChatId, record);
    const records = this.readRecords();
    records[record.sourceChatId] = {
      sourceChatId: record.sourceChatId,
      sourceMessageId: record.sourceMessageId,
      ...(record.replyToId ? { replyToId: record.replyToId } : {}),
      receivedAt: record.receivedAt,
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify({ version: 1, records }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(tempPath, this.statePath);
  }

  get(sourceChatId) {
    const records = this.readRecords();
    const persisted = records[sourceChatId];
    const inMemory = this.memory.get(sourceChatId);
    if (
      inMemory &&
      normalizeId(inMemory.sourceMessageId) === normalizeId(persisted?.sourceMessageId)
    ) {
      return inMemory;
    }
    return persisted;
  }
}

export function createTranslatorReplyRuntime({
  now = () => Date.now(),
  inboundStore = new InboundContextStore(statePath("reply-inbound.json"), now),
} = {}) {

  function messageReceived(event, ctx) {
    if (ctx.channelId && ctx.channelId !== "telegram") return false;
    if (ctx.accountId && ctx.accountId !== settings.accountId) return;
    const parsed = parseTranslatorSessionKey(ctx.sessionKey || event.sessionKey);
    const sourceChatId = normalizeChatId(
      ctx.senderId || event.senderId || ctx.conversationId || event.from || parsed?.peerId,
    );
    const sourceMessageId = normalizeId(ctx.messageId || event.messageId);
    if (
      !sourceChatId ||
      !sourceMessageId ||
      !allowedChatIds().has(sourceChatId)
    ) {
      return false;
    }
    if (parsed && parsed.peerId !== sourceChatId) return false;
    inboundStore.capture({
      sourceChatId,
      sourceMessageId,
      sourceBody: event.content,
      replyToId: normalizeId(
        ctx.replyToId || ctx.replyToIdFull || event.replyToId || event.replyToIdFull,
      ),
      replyToBody: ctx.replyToBody || event.replyToBody,
      fallbackUsed: false,
      receivedAt: now(),
    });
    return true;
  }

  function getInbound(sourceChatId) {
    let inbound;
    try {
      inbound = inboundStore.get(sourceChatId);
    } catch {
      return undefined;
    }
    if (!inbound) return undefined;
    if (now() - inbound.receivedAt > MAX_INBOUND_AGE_MS) {
      return undefined;
    }
    return inbound;
  }

  return { messageReceived, getInbound };
}

function getSharedReplyRuntime() {
  globalThis[SHARED_RUNTIME_KEY] ??= createTranslatorReplyRuntime();
  return globalThis[SHARED_RUNTIME_KEY];
}

export function createTranslatorSendTool({
  api,
  ctx,
  store,
  replyRuntime,
  loadAdapter = async () => api.runtime.channel.outbound.loadAdapter("telegram"),
}) {
  const parsed = parseTranslatorSessionKey(ctx.sessionKey);
  if (ctx.agentId !== settings.agentId || !parsed) return null;
  const requesterSenderId = normalizeChatId(ctx.requesterSenderId);
  if (requesterSenderId && requesterSenderId !== parsed.peerId) return null;

  return {
    name: TOOL_NAME,
    description:
      `Send a translated Telegram message or forwarded media to the other participant. Target ${settings.ownerChatId} expects Russian; target ${settings.partnerChatId} expects English. The tool validates direction, applies native reply routing, and records the cross-chat message-ID map atomically.`,
    parameters: translatorSendParameters(),
    async execute(_toolCallId, input) {
      const targetChatId = normalizeId(input?.target);
      if (!targetChatId || !allowedChatIds().has(targetChatId)) {
        return textResult({ ok: false, error: "target_not_allowed" }, true);
      }
      if (targetChatId === parsed.peerId) {
        return textResult({ ok: false, error: "target_must_be_other_participant" }, true);
      }

      const hasMessage = typeof input?.message === "string" && input.message.length > 0;
      const hasMedia = typeof input?.media === "string" && input.media.length > 0;
      if (!hasMessage && !hasMedia) {
        return textResult({ ok: false, error: "message_or_media_required" }, true);
      }

      const inbound = replyRuntime.getInbound(parsed.peerId);
      const translatedText = hasMessage
        ? input.message
        : typeof input?.caption === "string"
          ? input.caption
          : undefined;
      const languageMismatch = detectTargetLanguageMismatch({
        sourceChatId: parsed.peerId,
        sourceText: inbound?.sourceBody,
        outputText: translatedText,
      });
      if (languageMismatch) {
        const safeToRetry = inbound?.languageCorrectionUsed !== true;
        if (inbound) inbound.languageCorrectionUsed = true;
        return textResult(
          {
            ok: false,
            error: "target_language_mismatch",
            expectedLanguage: languageMismatch.expectedLanguage,
            telegramRequestSent: false,
            safeToRetry,
            instruction: safeToRetry
              ? `Translate the original inbound message to ${languageMismatch.expectedLanguage} and call translator_send exactly once more.`
              : "Do not call translator_send again for this inbound message.",
          },
          true,
        );
      }

      let params = { ...input };
      let replyToId;
      let fallbackApplied = false;
      if (inbound?.replyToId) {
        let mapped;
        try {
          mapped = store.get(inbound.sourceChatId, inbound.replyToId);
        } catch (error) {
          api.logger?.warn?.(
            `translator-reply-map: mapping lookup failed; sending without native reply (${String(error)})`,
          );
        }
        if (mapped?.peerChatId === targetChatId) {
          replyToId = mapped.peerMessageId;
        } else if (!inbound.fallbackUsed) {
          const withFallback = addFallbackQuote(params, inbound.replyToBody);
          fallbackApplied = withFallback !== params;
          params = withFallback;
          inbound.fallbackUsed = true;
        }
      }

      const adapter = await loadAdapter();
      if ((!hasMedia && !adapter?.sendText) || (hasMedia && !adapter?.sendMedia)) {
        return textResult({ ok: false, error: "telegram_outbound_adapter_unavailable" }, true);
      }

      const common = {
        cfg: api.config,
        to: targetChatId,
        accountId: settings.accountId,
        ...(replyToId ? { replyToId } : {}),
      };
      const result = hasMedia
        ? await adapter.sendMedia({
            ...common,
            text: typeof params.caption === "string" ? params.caption : "",
            mediaUrl: params.media,
            mediaLocalRoots: settings.mediaLocalRoots,
            audioAsVoice: params.asVoice === true,
            forceDocument: params.forceDocument === true,
          })
        : await adapter.sendText({
            ...common,
            text: params.message,
          });

      const targetMessageId = extractMessageId(result);
      if (!targetMessageId) {
        return textResult({
          ok: true,
          target: targetChatId,
          replyToApplied: Boolean(replyToId),
          fallbackApplied,
          mappingSkipped: "delivery_result_missing_message_id",
        });
      }

      let mappingSkipped;
      if (!inbound) {
        mappingSkipped = "inbound_context_missing";
      } else {
        try {
          await store.link(
            inbound.sourceChatId,
            inbound.sourceMessageId,
            targetChatId,
            targetMessageId,
          );
        } catch (error) {
          mappingSkipped = "reply_map_persist_failed";
          api.logger?.warn?.(
            `translator-reply-map: delivery succeeded but mapping failed (${String(error)})`,
          );
        }
      }
      return textResult({
        ok: true,
        target: targetChatId,
        messageId: targetMessageId,
        replyToApplied: Boolean(replyToId),
        fallbackApplied,
        ...(mappingSkipped ? { mappingSkipped } : {}),
      });
    },
  };
}

export function registerTranslatorReplyMap(api) {
  configureTranslatorReplyMap(api.pluginConfig);
  const store = new ReplyMapStore();
  const replyRuntime = getSharedReplyRuntime();
  api.on("message_received", replyRuntime.messageReceived, {
    priority: 200,
    timeoutMs: 1000,
  });
  api.registerTool(
    (ctx) => createTranslatorSendTool({ api, ctx, store, replyRuntime }),
    { names: [TOOL_NAME] },
  );
}
