# v0.21.0

## Conversation isolation and reliability

- Full-history requests are authoritative and stateless by default. The proxy no longer derives a shared conversation from the first user message.
- Stateful continuation requires `history_mode: "delta"` and an explicitly supplied `conversation_id`, `chat_id`, `thread_id`, or matching header. Missing, expired, foreign, or model-mismatched state returns a stable 4xx error instead of silently rebuilding from the last turn.
- Context records are scoped by credential and, when supplied, `x-client-session-id`. The built-in UI creates a random browser-local scope and sends it on business requests, so copied conversation IDs and copied browser scope values cannot cross API-key boundaries.
- Generation and final cursor commits are serialized per owned conversation. Separate conversations continue to run concurrently.
- OpenAI Chat Completions, Responses, Anthropic Messages, and Gemini adapters now share the same context contract.

## Long context and UI

- Canonical normalized message graphs are used for TXT/JSON packaging, preserving earlier system, user, assistant, tool, and attachment references for fiction and programming workflows.
- Long-context transport instructions are neutral and no longer demand citations, exclusive facts, or internal protocol recitation.
- Optical compression is lazy, serialized, cache-bounded, and falls back to the complete source when page coverage is truncated.
- Added a reachable persistent dark theme with synchronized header/sidebar/chat controls, mobile drawer focus handling, keyboard support, and responsive composer layout.
- Usage reporting continues to expose estimated input, output, total tokens, elapsed time, and generation speed.

## Security and operations

- Client-controlled remote attachments and mailbox-provider requests validate every DNS destination, block private/special IPv4 and IPv6 ranges, pin approved lookups, bound redirects and response sizes, and strip credentials after origin changes.
- Persisted-admin deployments no longer fail open when business keys are empty or revoked.
- Conversation list/read/stop access is scoped; foreign or unknown conversations are rejected before upstream access.
- Character-card metadata inflation, state-file symlink loops, upstream branch selection, and optical renderer failure paths are bounded and covered by regressions.
- Deployment archives are built from tracked files plus an explicit allowlist, reject tracked secrets/state, preserve executable modes and LF text, and fail closed on durable-state conflicts without deleting either copy.

## Verification

- Full `npm test` release gate passes, including the 100-request stress test, 43-case HTTP isolation suite, UI theme matrix, security regressions, and offline deployment migration tests.
- Research references used for the session contract: [Sub2API](https://github.com/Wei-Shaw/sub2api), [grok2api](https://github.com/chenyme/grok2api), [Kimi-Free-API](https://github.com/xiaoY233/Kimi-Free-API), and [OpenAI conversation state guidance](https://developers.openai.com/api/docs/guides/conversation-state).
