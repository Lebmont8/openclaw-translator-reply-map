# OpenClaw Translator Reply Map

An OpenClaw plugin that preserves native Telegram reply chains across a
two-party Russian/English translator agent.

When participant B replies to a translated copy, the plugin resolves the
corresponding message in participant A's chat and sends a native Telegram reply
there. Correlation state stores IDs and timestamps only, never conversation
text.

## Features

- bidirectional message-ID correlation
- native replies in both Telegram chats
- text, media, document, and voice delivery
- Russian/English pre-send language guard
- one safe correction attempt before Telegram delivery
- bounded in-memory quote fallback for unknown old replies
- fail-open ordinary delivery when correlation state is missing or corrupt

## Install

```bash
openclaw plugins install git:github.com/Lebmont8/openclaw-translator-reply-map
```

```json
{
  "plugins": {
    "entries": {
      "translator-reply-map": {
        "enabled": true,
        "config": {
          "ownerChatId": "100000001",
          "partnerChatId": "100000002",
          "agentId": "translator",
          "accountId": "translator",
          "mediaLocalRoots": []
        }
      }
    }
  }
}
```

The translator agent calls `translator_send` instead of sending directly. The
tool enforces the opposite participant as target, validates output script,
delivers through OpenClaw's Telegram adapter, and atomically stores the mapping.

## Development

```bash
npm run verify
npm pack --dry-run
```

MIT licensed.

## Verification scope

GitHub Actions runs the existing network-free checks on Node.js 22 and 24. These tests do not log into a provider, restart a Gateway, or prove compatibility with every OpenClaw release. Verify your installed runtime API before deployment; model identifiers in configuration examples must exist in your own account.
