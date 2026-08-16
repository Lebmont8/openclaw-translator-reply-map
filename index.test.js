import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InboundContextStore,
  ReplyMapStore,
  createTranslatorReplyRuntime,
  createTranslatorSendTool,
  detectTargetLanguageMismatch,
  extractMessageId,
  parseTranslatorSessionKey,
} from "./core.js";

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translator-reply-map-"));
  let now = 1_800_000_000_000;
  const store = new ReplyMapStore(path.join(dir, "reply-map.json"), () => now);
  const inboundStatePath = path.join(dir, "reply-inbound.json");
  const makeReplyRuntime = () =>
    createTranslatorReplyRuntime({
      now: () => now,
      inboundStore: new InboundContextStore(inboundStatePath, () => now),
    });
  const replyRuntime = makeReplyRuntime();
  const sent = [];
  let nextMessageId = 90;
  const adapter = {
    async sendText(params) {
      sent.push({ kind: "text", ...params });
      return { channel: "telegram", messageId: String(nextMessageId++), chatId: params.to };
    },
    async sendMedia(params) {
      sent.push({ kind: "media", ...params });
      return { channel: "telegram", messageId: String(nextMessageId++), chatId: params.to };
    },
  };
  const api = { config: {}, logger: {}, runtime: { channel: { outbound: {} } } };
  const makeTool = (sourceChatId, runtime = replyRuntime) =>
    createTranslatorSendTool({
      api,
      ctx: {
        agentId: "translator",
        sessionKey: `agent:translator:telegram:translator:direct:${sourceChatId}`,
        requesterSenderId: sourceChatId,
      },
      store,
      replyRuntime: runtime,
      loadAdapter: async () => adapter,
    });
  return {
    dir,
    store,
    replyRuntime,
    sent,
    makeTool,
    makeReplyRuntime,
    advance(ms) {
      now += ms;
    },
  };
}

function receive(replyRuntime, sourceChatId, messageId, extra = {}) {
  return replyRuntime.messageReceived(
    { messageId, ...extra },
    {
      channelId: "telegram",
      accountId: "translator",
      conversationId: sourceChatId,
      senderId: sourceChatId,
      messageId,
    },
  );
}

test("extracts message ids from direct and nested tool results", () => {
  assert.equal(extractMessageId({ messageId: 42 }), "42");
  assert.equal(
    extractMessageId({ content: [{ type: "text", text: '{"message_id":77}' }] }),
    "77",
  );
});

test("parses only the two translator direct sessions", () => {
  assert.deepEqual(
    parseTranslatorSessionKey("agent:translator:telegram:translator:direct:100000001"),
    { peerId: "100000001" },
  );
  assert.equal(parseTranslatorSessionKey("agent:main:telegram:direct:100000001"), null);
  assert.equal(
    parseTranslatorSessionKey("agent:translator:telegram:translator:direct:123"),
    null,
  );
});

test("captures the actual message_received shape without a session key", (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const captured = receive(h.replyRuntime, "100000001", "41", {
    content: "Что случилось?",
    replyToId: "40",
    replyToBody: "previous",
  });

  assert.equal(captured, true);
  assert.equal(h.replyRuntime.getInbound("100000001").sourceMessageId, "41");
  assert.equal(h.replyRuntime.getInbound("100000001").sourceBody, "Что случилось?");
  const persisted = JSON.parse(
    fs.readFileSync(path.join(h.dir, "reply-inbound.json"), "utf8"),
  );
  assert.deepEqual(persisted.records["100000001"], {
    sourceChatId: "100000001",
    sourceMessageId: "41",
    replyToId: "40",
    receivedAt: 1_800_000_000_000,
  });
  assert.equal(JSON.stringify(persisted).includes("previous"), false);
  assert.equal(JSON.stringify(persisted).includes("Что случилось?"), false);
});

test("detects wrong target language while allowing translated names and URLs", () => {
  assert.deepEqual(
    detectTargetLanguageMismatch({
      sourceChatId: "100000002",
      sourceText: "What is it",
      outputText: "What is it?",
    }),
    { expectedLanguage: "Russian", target: "100000001" },
  );
  assert.equal(
    detectTargetLanguageMismatch({
      sourceChatId: "100000002",
      sourceText: "Tell John https://example.com",
      outputText: "Скажи John https://example.com",
    }),
    undefined,
  );
  assert.equal(
    detectTargetLanguageMismatch({
      sourceChatId: "100000002",
      sourceText: "https://example.com",
      outputText: "https://example.com",
    }),
    undefined,
  );
});

test("blocks untranslated English before Telegram and allows one corrected retry", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  receive(h.replyRuntime, "100000002", "49", { content: "What is it" });
  const tool = h.makeTool("100000002");

  const rejected = await tool.execute("call-language-1", {
    target: "100000001",
    message: "What is it?",
  });
  assert.equal(rejected.details.error, "target_language_mismatch");
  assert.equal(rejected.details.telegramRequestSent, false);
  assert.equal(rejected.details.safeToRetry, true);
  assert.equal(h.sent.length, 0);

  const corrected = await tool.execute("call-language-2", {
    target: "100000001",
    message: "Что это?",
  });
  assert.equal(corrected.details.ok, true);
  assert.equal(h.sent[0].text, "Что это?");
});

test("blocks a second wrong-language attempt without sending", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  receive(h.replyRuntime, "100000002", "51", { content: "Wtf" });
  const tool = h.makeTool("100000002");

  await tool.execute("call-language-3", {
    target: "100000001",
    message: "What the fuck?",
  });
  const rejectedAgain = await tool.execute("call-language-4", {
    target: "100000001",
    message: "What the hell?",
  });
  assert.equal(rejectedAgain.details.safeToRetry, false);
  assert.equal(h.sent.length, 0);
});

test("enforces Russian to English direction before Telegram", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  receive(h.replyRuntime, "100000001", "53", { content: "Что это?" });
  const tool = h.makeTool("100000001");

  const rejected = await tool.execute("call-language-5", {
    target: "100000002",
    message: "Что это?",
  });
  assert.equal(rejected.details.expectedLanguage, "English");
  assert.equal(h.sent.length, 0);

  const corrected = await tool.execute("call-language-6", {
    target: "100000002",
    message: "What is it?",
  });
  assert.equal(corrected.details.ok, true);
  assert.equal(h.sent[0].text, "What is it?");
});

test("native Codex path sends through translator_send and stores both directions", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  receive(h.replyRuntime, "100000001", "11");

  const result = await h.makeTool("100000001").execute("call-1", {
    target: "100000002",
    message: "hello",
  });

  assert.equal(result.details.ok, true);
  assert.equal(h.sent[0].to, "100000002");
  assert.equal(h.sent[0].replyToId, undefined);
  assert.equal(h.store.get("100000001", "11").peerMessageId, "90");
  assert.equal(h.store.get("100000002", "90").peerMessageId, "11");
});

test("applies mapped native reply in the reverse direction", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  await h.store.link("100000001", "10", "100000002", "80");
  receive(h.replyRuntime, "100000002", "12", {
    replyToId: "80",
    replyToBody: "previous",
  });

  const result = await h.makeTool("100000002").execute("call-2", {
    target: "100000001",
    message: "привет",
  });

  assert.equal(result.details.replyToApplied, true);
  assert.equal(h.sent[0].replyToId, "10");
  assert.equal(h.store.get("100000002", "12").peerMessageId, "90");
});

test("shares ID-only inbound context across separate runtime instances", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  await h.store.link("100000001", "10", "100000002", "80");
  receive(h.replyRuntime, "100000002", "12", {
    replyToId: "80",
    replyToBody: "not persisted",
  });

  const secondRuntime = h.makeReplyRuntime();
  const result = await h.makeTool("100000002", secondRuntime).execute("call-2b", {
    target: "100000001",
    message: "привет",
  });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.replyToApplied, true);
  assert.equal(h.sent[0].replyToId, "10");
  assert.equal(h.store.get("100000002", "12").peerMessageId, "90");
});

test("unknown old reply falls back to a bounded quote once", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  receive(h.replyRuntime, "100000002", "33", {
    replyToId: "32",
    replyToBody: "old message",
  });

  const first = await h.makeTool("100000002").execute("call-3", {
    target: "100000001",
    message: "перевод",
  });
  const second = await h.makeTool("100000002").execute("call-4", {
    target: "100000001",
    message: "второе",
  });

  assert.equal(first.details.fallbackApplied, true);
  assert.equal(h.sent[0].text, "↪ old message\n\nперевод");
  assert.equal(second.details.fallbackApplied, false);
  assert.equal(h.sent[1].text, "второе");
});

test("voice media stays primary while the translated text is also mapped", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  receive(h.replyRuntime, "100000001", "20");

  await h.makeTool("100000001").execute("call-5", {
    target: "100000002",
    media: "/tmp/openclaw-media/inbound/voice.ogg",
    asVoice: true,
  });
  await h.makeTool("100000001").execute("call-6", {
    target: "100000002",
    message: "voice translation",
  });

  assert.equal(h.sent[0].kind, "media");
  assert.equal(h.sent[0].audioAsVoice, true);
  assert.equal(h.store.get("100000001", "20").peerMessageId, "90");
  assert.equal(h.store.get("100000002", "90").peerMessageId, "20");
  assert.equal(h.store.get("100000002", "91").peerMessageId, "20");
});

test("rejects same-side delivery but stale context cannot block delivery", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  receive(h.replyRuntime, "100000001", "30");
  const sameSide = await h.makeTool("100000001").execute("call-7", {
    target: "100000001",
    message: "wrong",
  });
  assert.equal(sameSide.isError, true);

  h.advance(10 * 60 * 1000 + 1);
  const stale = await h.makeTool("100000001").execute("call-8", {
    target: "100000002",
    message: "late",
  });
  assert.equal(stale.details.ok, true);
  assert.equal(stale.details.mappingSkipped, "inbound_context_missing");
  assert.equal(h.sent.length, 1);
});

test("missing or corrupt inbound state cannot block ordinary delivery", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(h.dir, "reply-inbound.json"), "not-json");

  const result = await h.makeTool("100000001", h.makeReplyRuntime()).execute(
    "call-9",
    { target: "100000002", message: "still delivered" },
  );

  assert.equal(result.details.ok, true);
  assert.equal(result.details.mappingSkipped, "inbound_context_missing");
  assert.equal(h.sent[0].text, "still delivered");
});

test("corrupt reply map cannot block a translated reply", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(h.dir, "reply-map.json"), "not-json");
  receive(h.replyRuntime, "100000002", "51", {
    replyToId: "50",
    replyToBody: "old message",
  });

  const result = await h.makeTool("100000002").execute("call-10", {
    target: "100000001",
    message: "перевод",
  });

  assert.equal(result.details.ok, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, "↪ old message\n\nперевод");
});
