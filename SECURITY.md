# Security

Persistent state contains only chat IDs, message IDs, timestamps, and their
cross-chat relationship. Message and caption text are never persisted. A
bounded fallback quote may exist only in current process memory.

Configure exactly two trusted participant IDs. Report vulnerabilities through
a private GitHub security advisory.
